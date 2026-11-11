import { ApduStatusError, createIdentityYubiKeyService, IdentityHardwareError } from '../../src/index.js';
import { describe, expect, it, vi } from 'vitest';
import { PRIVATE_DIAGNOSTIC, expectSanitized, protocolPeer } from '../identityTestHelpers.js';
import { hardware, occupied, OTHER_KEY, PUBLIC_KEY, SERIAL, sessionPool } from '../identityYubikeyHelpers.js';

function agreementFixture(secret = Buffer.alloc(32, 7)) {
  const h = hardware();
  const raw = Buffer.concat([Buffer.from('7c228220', 'hex'), secret]);
  h.card.transmit.mockResolvedValue(raw);
  const service = createIdentityYubiKeyService(h.transport);
  return { ...h, raw, service, agreement: service.createAgreement({ serial: SERIAL, expectedPublicKey: PUBLIC_KEY }) };
}

async function rejects(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(IdentityHardwareError);
  await promise.catch((error: unknown) => expectSanitized(error, IdentityHardwareError, code));
}

describe('pinned native identity agreement', () => {
  it('clears a copied secret if scoped-session cleanup fails after agreement', async () => {
    const h = agreementFixture();
    let returned: { sharedSecret: Buffer } | undefined;
    h.withSelectedCard.mockImplementation(async (_serial, callback) => {
      returned = (await callback(h.card)) as { sharedSecret: Buffer };
      throw new Error(PRIVATE_DIAGNOSTIC);
    });
    await rejects(h.agreement.agree(protocolPeer()), 'DEVICE_FAILED');
    expect(returned!.sharedSecret).toEqual(Buffer.alloc(32));
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
  });
  it.each([Buffer.alloc(0), Buffer.alloc(65, 4), PUBLIC_KEY.subarray(0, 33)])(
    'rejects missing, off-curve, or noncanonical pins before card access',
    (expectedPublicKey) => {
      const h = hardware();
      expect(() =>
        createIdentityYubiKeyService(h.transport).createAgreement({ serial: SERIAL, expectedPublicKey }),
      ).toThrow(IdentityHardwareError);
      expect(h.withSelectedCard).not.toHaveBeenCalled();
    },
  );

  it('rejects device names before card access', () => {
    const h = hardware();
    expect(() =>
      createIdentityYubiKeyService(h.transport).createAgreement({ serial: 'my-key', expectedPublicKey: PUBLIC_KEY }),
    ).toThrow(IdentityHardwareError);
    expect(h.withSelectedCard).not.toHaveBeenCalled();
  });

  it('rejects an off-curve peer before card access', async () => {
    const h = agreementFixture();
    await expect(h.agreement.agree(Buffer.alloc(65, 4))).rejects.toBeInstanceOf(IdentityHardwareError);
    expect(h.withSelectedCard).not.toHaveBeenCalled();
  });

  it('verifies fresh metadata before and after ECDH and transfers an isolated secret', async () => {
    const secret = Buffer.alloc(32, 7);
    secret[0] = 0;
    const h = agreementFixture(secret);
    const result = await h.agreement.agree(protocolPeer());
    expect(h.withSelectedCard).toHaveBeenCalledExactlyOnceWith(SERIAL, expect.any(Function));
    expect(h.card.getSlotMetadata).toHaveBeenCalledTimes(2);
    for (const [slot] of h.card.getSlotMetadata.mock.calls) expect(slot).toBe('9d');
    expect(h.card.transmit).toHaveBeenCalledOnce();
    const command = h.card.transmit.mock.calls[0]![0];
    expect(command.subarray(0, 5).toString('hex')).toBe('0087119d47');
    expect(command.subarray(5, 11).toString('hex')).toBe('7c4582008541');
    expect(command.subarray(11, 76)).toEqual(protocolPeer());
    expect(result.publicKey).toEqual(PUBLIC_KEY);
    expect(result.sharedSecret).toEqual(secret);
    expect(Buffer.isBuffer(result.sharedSecret)).toBe(true);
    expect(result.sharedSecret).toHaveLength(32);
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
    expect(h.card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(h.card.verifyPin).not.toHaveBeenCalled();
    expect(Object.keys(h.agreement)).toEqual(['agree']);
    result.sharedSecret.fill(0);
  });

  it('copies the public pin before caller mutation', async () => {
    const h = agreementFixture();
    const pin = Buffer.from(PUBLIC_KEY);
    const agreement = h.service.createAgreement({ serial: SERIAL, expectedPublicKey: pin });
    pin.set(OTHER_KEY);
    const result = await agreement.agree(protocolPeer());
    expect(result.publicKey).toEqual(PUBLIC_KEY);
    result.sharedSecret.fill(0);
  });

  it.each(['empty', 'unknown', 'algorithm', 'malformed', 'mismatch'])(
    'rejects %s root before ECDH',
    async (failure) => {
      const h = agreementFixture();
      const metadata = failure === 'mismatch' ? occupied(OTHER_KEY) : { ...occupied() };
      if (failure === 'empty' || failure === 'unknown') Object.assign(metadata, { status: failure });
      if (failure === 'algorithm') Object.assign(metadata, { algorithm: 0x16 });
      if (failure === 'malformed') Object.assign(metadata, { publicKeyTemplate: Buffer.from('864104', 'hex') });
      h.card.getSlotMetadata.mockResolvedValue(metadata);
      await rejects(
        h.agreement.agree(protocolPeer()),
        failure === 'mismatch' ? 'ROOT_KEY_MISMATCH' : 'ROOT_UNAVAILABLE',
      );
      expect(h.card.transmit).not.toHaveBeenCalled();
    },
  );

  it('reads fresh metadata around every agreement in one retained session', async () => {
    const h = agreementFixture();
    h.card.transmit.mockImplementation(async () =>
      Buffer.concat([Buffer.from('7c228220', 'hex'), Buffer.alloc(32, 7)]),
    );
    const first = await h.agreement.agree(protocolPeer());
    const second = await h.agreement.agree(protocolPeer());
    expect(h.card.getSlotMetadata).toHaveBeenCalledTimes(4);
    expect(h.card.transmit).toHaveBeenCalledTimes(2);
    first.sharedSecret.fill(0);
    second.sharedSecret.fill(0);
  });

  it('reads fresh metadata around every agreement across pooled card sessions', async () => {
    const first = hardware();
    const second = hardware();
    first.card.transmit.mockImplementation(async () =>
      Buffer.concat([Buffer.from('7c228220', 'hex'), Buffer.alloc(32, 7)]),
    );
    second.card.transmit.mockImplementation(async () =>
      Buffer.concat([Buffer.from('7c228220', 'hex'), Buffer.alloc(32, 7)]),
    );
    const cards = [first.card, first.card, second.card];
    const sessions = sessionPool(() => cards.shift()!);
    const agreement = createIdentityYubiKeyService(first.transport, sessions.pool).createAgreement({
      serial: SERIAL,
      expectedPublicKey: PUBLIC_KEY,
    });

    for (let index = 0; index < 3; index += 1) (await agreement.agree(protocolPeer())).sharedSecret.fill(0);

    expect(first.card.getSlotMetadata).toHaveBeenCalledTimes(4);
    expect(second.card.getSlotMetadata).toHaveBeenCalledTimes(2);
    expect(sessions.withCard).toHaveBeenCalledTimes(3);
    expect(first.withSelectedCard).not.toHaveBeenCalled();
  });

  it('does not perform ECDH when fresh pre-operation metadata is unavailable', async () => {
    const h = agreementFixture();
    h.card.getSlotMetadata.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));

    await rejects(h.agreement.agree(protocolPeer()), 'DEVICE_FAILED');

    expect(h.card.transmit).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'mismatch'])(
    'discards and wipes the secret when fresh post-operation metadata is %s',
    async (failure) => {
      const h = agreementFixture();
      h.card.getSlotMetadata.mockResolvedValueOnce(occupied());
      if (failure === 'unavailable') h.card.getSlotMetadata.mockRejectedValueOnce(new Error(PRIVATE_DIAGNOSTIC));
      else h.card.getSlotMetadata.mockResolvedValueOnce(occupied(OTHER_KEY));

      await rejects(h.agreement.agree(protocolPeer()), failure === 'mismatch' ? 'ROOT_KEY_MISMATCH' : 'DEVICE_FAILED');

      expect(h.card.transmit).toHaveBeenCalledOnce();
      expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
    },
  );

  it.each([
    Buffer.from('7c0182', 'hex'),
    Buffer.concat([Buffer.from('7c21821f', 'hex'), Buffer.alloc(31, 7)]),
    Buffer.concat([Buffer.from('7c238221', 'hex'), Buffer.alloc(33, 7)]),
    Buffer.concat([Buffer.from('7c228220', 'hex'), Buffer.alloc(32)]),
    Buffer.concat([Buffer.from('7c228220', 'hex'), Buffer.alloc(32, 7), Buffer.from([0])]),
  ])('clears malformed/noncanonical secret response on rejection', async (raw) => {
    const h = agreementFixture();
    h.card.transmit.mockResolvedValue(raw);
    await expect(h.agreement.agree(protocolPeer())).rejects.toBeInstanceOf(IdentityHardwareError);
    expect(raw).toEqual(Buffer.alloc(raw.length));
    expect(h.card.transmit).toHaveBeenCalledOnce();
  });

  it.each(['never', 'once', 'always'] as const)(
    'preverifies only explicit PIN callbacks and policy %s',
    async (pinPolicy) => {
      const h = agreementFixture();
      h.card.getSlotMetadata.mockResolvedValue({ ...occupied(), pinPolicy } as ReturnType<typeof occupied>);
      const promptPin = vi.fn(async () => '123456');
      const agreement = h.service.createAgreement({ serial: SERIAL, expectedPublicKey: PUBLIC_KEY, promptPin });
      const result = await agreement.agree(protocolPeer());
      if (pinPolicy === 'never') expect(h.card.verifyPin).not.toHaveBeenCalled();
      else {
        expect(h.card.verifyPin).toHaveBeenCalledExactlyOnceWith(promptPin);
        expect(h.card.clearPinVerification).toHaveBeenCalledOnce();
      }
      result.sharedSecret.fill(0);
    },
  );

  it.each([0x6982, 0x63c2])(
    'returns actionable authorization failure for %x without retry or implicit prompt',
    async (status) => {
      const h = agreementFixture();
      h.card.transmit.mockRejectedValue(new ApduStatusError(status));
      const operation = h.agreement.agree(protocolPeer());
      await rejects(operation, 'AUTHORIZATION_REQUIRED');
      await operation.catch((error: Error) => expect(error.message).toMatch(/CLI|ccd-id-manager/));
      expect(h.card.transmit).toHaveBeenCalledOnce();
      expect(h.card.verifyPin).not.toHaveBeenCalled();
    },
  );

  it('sanitizes backend failures and never retries or falls back from shared access', async () => {
    const h = agreementFixture();
    h.withSelectedCard.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    await rejects(h.agreement.agree(protocolPeer()), 'DEVICE_FAILED');
    expect(h.withSelectedCard).toHaveBeenCalledOnce();
    expect(h.card.transmit).not.toHaveBeenCalled();
  });
});

describe('native identity PIN control', () => {
  it('queries, verifies, and clears device-wide PIN state', async () => {
    const h = hardware();
    const service = createIdentityYubiKeyService(h.transport);
    const promptPin = vi.fn(async () => '123456');

    await expect(service.pinStatus(SERIAL)).resolves.toEqual({ status: 'required', retries: 3 });
    await service.pinUnlock(SERIAL, promptPin);
    await service.pinLock(SERIAL);

    expect(h.withSelectedCard).toHaveBeenCalledTimes(3);
    expect(h.card.selectPiv).toHaveBeenCalledTimes(3);
    expect(h.card.verifyPin).toHaveBeenCalledExactlyOnceWith(promptPin);
    expect(h.card.clearPinVerification).toHaveBeenCalledOnce();
  });

  it('sanitizes PIN verification failures without retry', async () => {
    const h = hardware();
    h.card.verifyPin.mockRejectedValue(new ApduStatusError(0x63c2));
    const operation = createIdentityYubiKeyService(h.transport).pinUnlock(SERIAL, async () => 'bad');
    await rejects(operation, 'AUTHORIZATION_REQUIRED');
    expect(h.card.verifyPin).toHaveBeenCalledOnce();
  });
});

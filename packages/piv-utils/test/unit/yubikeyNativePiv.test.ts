import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEd25519SignData,
  ApduStatusError,
  parseEd25519SignatureResponse,
} from '../../src/index.js';
import { composePivYubiKeyService } from '../../src/yubikeyNativePiv.js';
import type { PivCardSession, PivSlotMetadata, PivTransport } from '../../src/types.js';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex, YubiKeyInteractionProvider, YubiKeyService } from '../../src/yubikeyService.js';
const testEd25519PublicKey = (byteHex: string) => byteHex.repeat(32) as Ed25519PublicKeyHex;
const TEST_PUBLIC_KEY_AB = testEd25519PublicKey('ab');

const PUBLIC_KEY = TEST_PUBLIC_KEY_AB;
const PRIVATE_KEY = '11'.repeat(32) as Ed25519PrivateKeyHex;

describe('native PIV Ed25519 signing helpers', () => {
  it('builds the GENERAL AUTHENTICATE dynamic-authentication payload', () => {
    expect(buildEd25519SignData(Buffer.from('aa'.repeat(32), 'hex')).toString('hex')).toBe(
      `7c2482008120${'aa'.repeat(32)}`,
    );
    expect(buildEd25519SignData(Buffer.alloc(128)).toString('hex')).toContain('8180');
    expect(buildEd25519SignData(Buffer.alloc(256)).toString('hex')).toContain('820100');
  });

  it('extracts a 64-byte Ed25519 signature from a response template', () => {
    const signature = '11'.repeat(64);

    expect(parseEd25519SignatureResponse(Buffer.from(`7c428240${signature}`, 'hex')).toString('hex')).toBe(signature);
  });

  it('rejects malformed signature templates', () => {
    expect(() => parseEd25519SignatureResponse(Buffer.from('7d00', 'hex'))).toThrow('malformed Ed25519 signature response');
    expect(() => parseEd25519SignatureResponse(Buffer.from('7c03820100', 'hex'))).toThrow('malformed Ed25519 signature value');
    expect(() => parseEd25519SignatureResponse(Buffer.from(`7c428240${'11'.repeat(64)}00`, 'hex'))).toThrow(
      'malformed Ed25519 signature response',
    );
  });

});

function serviceFixture(metadata: PivSlotMetadata = {
  algorithm: 0xe0,
  origin: 'generated',
  pinPolicy: 'once',
  publicKeyTemplate: Buffer.from(`8620${PUBLIC_KEY}`, 'hex'),
  slot: '9c',
  status: 'occupied',
  touchPolicy: 'never',
}) {
  const card = {
    readerName: 'Test reader',
    selectPiv: vi.fn(async () => undefined),
    getSerial: vi.fn(async () => '12345678'),
    getVersion: vi.fn(async () => '5.8.0'),
    getDeviceInfo: vi.fn(async () => ({})),
    getSlotMetadata: vi.fn(async (slot: string) => slot === metadata.slot ? metadata : { slot, status: 'empty' }),
    authenticateManagementKey: vi.fn(async () => undefined),
    verifyPin: vi.fn<PivCardSession['verifyPin']>(async () => undefined),
    getPinStatus: vi.fn<PivCardSession['getPinStatus']>(async () => ({ status: 'required', retries: 3 })),
    clearPinVerification: vi.fn(async () => undefined),
    reboot: vi.fn(async () => undefined),
    transmit: vi.fn(async (command: Buffer) => {
      if (command[1] === 0x47) return Buffer.from(`7f49228620${PUBLIC_KEY}`, 'hex');
      if (command[1] === 0x87) return Buffer.from(`7c428240${'ef'.repeat(64)}`, 'hex');
      return Buffer.alloc(0);
    }),
    disconnect: vi.fn(async () => undefined),
  };
  const transport = {
    withCards: vi.fn(async (callback: (cards: PivCardSession[]) => Promise<unknown>) => callback([card as unknown as PivCardSession])),
    withSelectedCard: vi.fn(async (_serial: string | undefined, callback: (card: PivCardSession) => Promise<unknown>) => callback(card as unknown as PivCardSession)),
    watchDevices: vi.fn(),
  } as unknown as PivTransport;
  return { card, service: composePivYubiKeyService(transport), transport };
}

const interaction = () => ({
  confirm: vi.fn(async () => true),
  promptManagementKey: vi.fn(async () => '01'.repeat(24)),
  promptPin: vi.fn(async () => '123456'),
});

type KeyMutation = 'generate' | 'import';

function mutateKey(service: YubiKeyService, mutation: KeyMutation, prompts: YubiKeyInteractionProvider, force: boolean) {
  if (mutation === 'generate') {
    return service.generateEd25519Key({
      force, interaction: prompts, pinPolicy: 'once', serial: '12345678', slot: '9c', touchPolicy: 'never',
    });
  }
  return service.importEd25519Key({
    force, interaction: prompts, pinPolicy: 'once', privateKeyHex: PRIVATE_KEY,
    publicKey: PUBLIC_KEY, serial: '12345678', slot: '82', touchPolicy: 'never',
  });
}

describe('YubiKey service orchestration', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('rejects a disallowed runtime signing slot before transport access', async () => {
    const { service, transport } = serviceFixture();

    await expect(service.signEd25519Digest({
      devices: [{ kind: 'yubikey', serial: '12345678', slot: '9d' as never }],
      digest: Buffer.alloc(32),
      publicKey: PUBLIC_KEY,
    })).rejects.toThrow('Slot');

    expect(transport.withSelectedCard).not.toHaveBeenCalled();
  });

  it('maps trusted structured slot metadata without reparsing it through raw APDUs', async () => {
    const { card, service } = serviceFixture();

    await expect(service.inspectDevice('12345678')).resolves.toMatchObject({
      slots: expect.arrayContaining([{
        algorithm: 'Ed25519',
        origin: 'generated',
        pinPolicy: 'once',
        publicKey: PUBLIC_KEY,
        slot: '9c',
        status: 'occupied',
        touchPolicy: 'never',
      }]),
    });

    expect(card.getSlotMetadata).toHaveBeenCalled();
    expect(card.transmit).not.toHaveBeenCalled();
  });

  it('does not accept malformed public-key template framing from structured metadata', async () => {
    const { service } = serviceFixture({
      algorithm: 0xe0,
      publicKeyTemplate: Buffer.from(`8620${PUBLIC_KEY}00`, 'hex'),
      slot: '9c',
      status: 'occupied',
    });

    const inspection = await service.inspectDevice('12345678');
    expect(inspection.slots.find(({ slot }) => slot === '9c')).not.toHaveProperty('publicKey');
  });

  it('fails closed on unknown occupancy before authorization or mutation', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'unknown' });
    const prompts = interaction();

    await expect(service.generateEd25519Key({
      force: true, interaction: prompts, pinPolicy: 'once', serial: '12345678', slot: '9c', touchPolicy: 'never',
    })).rejects.toThrow('occupancy is unknown');

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(card.transmit).not.toHaveBeenCalled();
    expect(card.reboot).not.toHaveBeenCalled();
  });

  it('fails closed on unknown import occupancy before prompts or mutation', async () => {
    const { card, service } = serviceFixture({ slot: '82', status: 'unknown' });
    const prompts = interaction();

    await expect(service.importEd25519Key({
      force: true, interaction: prompts, pinPolicy: 'once', privateKeyHex: '11'.repeat(32) as never,
      publicKey: PUBLIC_KEY, serial: '12345678', slot: '82', touchPolicy: 'never',
    })).rejects.toThrow('occupancy is unknown');

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.promptManagementKey).not.toHaveBeenCalled();
    expect(prompts.promptPin).not.toHaveBeenCalled();
    expect(card.transmit).not.toHaveBeenCalled();
    expect(card.reboot).not.toHaveBeenCalled();
  });

  describe.each(['generate', 'import'] as const)('%s occupied-slot authorization', (mutation) => {
    const slot = mutation === 'generate' ? '9c' : '82';

    it('requires force without prompting or authorizing', async () => {
      const { card, service } = serviceFixture({
        algorithm: 0xe0, publicKeyTemplate: Buffer.from(`8620${PUBLIC_KEY}`, 'hex'), slot, status: 'occupied',
      });
      const prompts = interaction();

      await expect(mutateKey(service, mutation, prompts, false)).rejects.toThrow('occupied');

      expect(prompts.confirm).not.toHaveBeenCalled();
      expect(card.authenticateManagementKey).not.toHaveBeenCalled();
      expect(card.transmit).not.toHaveBeenCalled();
      expect(card.reboot).not.toHaveBeenCalled();
    });

    it('leaves the prior key untouched when replacement is declined', async () => {
      const { card, service } = serviceFixture({
        algorithm: 0xe0, publicKeyTemplate: Buffer.from(`8620${PUBLIC_KEY}`, 'hex'), slot, status: 'occupied',
      });
      const prompts = interaction();
      prompts.confirm.mockResolvedValueOnce(false);

      await expect(mutateKey(service, mutation, prompts, true)).rejects.toThrow('cancelled');

      expect(prompts.confirm).toHaveBeenCalledOnce();
      expect(card.authenticateManagementKey).not.toHaveBeenCalled();
      expect(card.transmit).not.toHaveBeenCalled();
      expect(card.reboot).not.toHaveBeenCalled();
    });

    it('reports the prior public key after one accepted replacement', async () => {
      const { card, service } = serviceFixture({
        algorithm: 0xe0, publicKeyTemplate: Buffer.from(`8620${PUBLIC_KEY}`, 'hex'), slot, status: 'occupied',
      });
      const prompts = interaction();

      await expect(mutateKey(service, mutation, prompts, true)).resolves.toMatchObject({
        publicKey: PUBLIC_KEY, replacedExistingKey: true, replacedPublicKey: PUBLIC_KEY,
      });

      expect(prompts.confirm).toHaveBeenCalledOnce();
      expect(card.authenticateManagementKey).toHaveBeenCalledOnce();
      expect(card.transmit).toHaveBeenCalledOnce();
    });
  });

  it('reports uncertain mutation facts and never retries a failed mutating APDU', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    card.transmit.mockRejectedValueOnce(new Error('mutation failed'));

    const error = await service.generateEd25519Key({
      force: false, interaction: interaction(), pinPolicy: 'once', serial: '12345678', slot: '9c', touchPolicy: 'never',
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({ mutation: {
      attempted: true, confirmed: false, rebootFailed: false, restorationFailed: false,
    } });
    expect(card.transmit).toHaveBeenCalledOnce();
    expect(card.reboot).toHaveBeenCalledOnce();
  });

  it('wraps a frozen mutation error while preserving its cause and mutation facts', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    const failure = Object.freeze(new Error('mutation failed'));
    card.transmit.mockRejectedValueOnce(failure);

    const error = await service.generateEd25519Key({
      force: false, interaction: interaction(), pinPolicy: 'once', serial: '12345678', slot: '9c', touchPolicy: 'never',
    }).catch((value: unknown) => value);

    expect(error).not.toBe(failure);
    expect(error).toMatchObject({ cause: failure, mutation: {
      attempted: true, confirmed: false, rebootFailed: false, restorationFailed: false,
    } });
  });

  it.each([
    { rebootFails: true, restorationFails: false },
    { rebootFails: false, restorationFails: true },
    { rebootFails: true, restorationFails: true },
  ])('reports confirmed cleanup facts and restores despite reboot failure: $rebootFails/$restorationFails', async ({ rebootFails, restorationFails }) => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    const prompts = interaction();
    card.getPinStatus.mockResolvedValue({ status: 'verified' });
    let verification = 0;
    card.verifyPin.mockImplementation(async (prompt: () => Promise<string>) => {
      verification += 1;
      await prompt();
      if (restorationFails && verification === 2) throw new Error('restoration failed');
    });
    if (rebootFails) card.reboot.mockRejectedValueOnce(new Error('reboot failed'));

    const error = await mutateKey(service, 'generate', prompts, false).catch((value: unknown) => value);

    expect(error).toMatchObject({ mutation: {
      attempted: true, confirmed: true, rebootFailed: rebootFails, restorationFailed: restorationFails,
    } });
    expect(prompts.promptPin).toHaveBeenCalledOnce();
    expect(card.transmit).toHaveBeenCalledOnce();
    expect(card.reboot).toHaveBeenCalledOnce();
    expect(card.verifyPin).toHaveBeenCalledTimes(2);
  });

  it('preserves the original mutation error when PIN restoration also fails', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    const failure = new Error('mutation failed');
    const prompts = interaction();
    card.getPinStatus.mockResolvedValue({ status: 'verified' });
    let verification = 0;
    card.verifyPin.mockImplementation(async (prompt: () => Promise<string>) => {
      verification += 1;
      await prompt();
      if (verification === 2) throw new Error('restoration failed');
    });
    card.transmit.mockRejectedValueOnce(failure);

    const error = await mutateKey(service, 'generate', prompts, false).catch((value: unknown) => value);

    expect(error).toBe(failure);
    expect(error).toMatchObject({ mutation: {
      attempted: true, confirmed: false, rebootFailed: false, restorationFailed: true,
    } });
    expect(prompts.promptPin).toHaveBeenCalledOnce();
    expect(card.transmit).toHaveBeenCalledOnce();
    expect(card.verifyPin).toHaveBeenCalledTimes(2);
  });

  it('preserves the original mutation error when reboot also fails', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    const failure = new Error('mutation failed');
    card.transmit.mockRejectedValueOnce(failure);
    card.reboot.mockRejectedValueOnce(new Error('reboot failed'));

    const error = await mutateKey(service, 'generate', interaction(), false).catch((value: unknown) => value);

    expect(error).toBe(failure);
    expect(error).toMatchObject({ mutation: {
      attempted: true, confirmed: false, rebootFailed: true, restorationFailed: false,
    } });
    expect(card.transmit).toHaveBeenCalledOnce();
    expect(card.reboot).toHaveBeenCalledOnce();
  });

  it('treats a successful generation APDU with an invalid response as confirmed and still reboots', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    card.transmit.mockResolvedValueOnce(Buffer.from('7f4900', 'hex'));

    const error = await mutateKey(service, 'generate', interaction(), false).catch((value: unknown) => value);

    expect(error).toMatchObject({
      message: expect.stringContaining('did not return'),
      mutation: { attempted: true, confirmed: true, rebootFailed: false, restorationFailed: false },
    });
    expect(card.transmit).toHaveBeenCalledOnce();
    expect(card.reboot).toHaveBeenCalledOnce();
  });

  it('wipes a rejected import command while reporting the mutation as unconfirmed', async () => {
    const { card, service } = serviceFixture({ slot: '82', status: 'empty' });
    let command: Buffer | undefined;
    card.transmit.mockImplementationOnce(async (value: Buffer) => {
      command = value;
      throw new Error('import rejected');
    });

    const error = await mutateKey(service, 'import', interaction(), false).catch((value: unknown) => value);

    expect(error).toMatchObject({ mutation: {
      attempted: true, confirmed: false, rebootFailed: false, restorationFailed: false,
    } });
    expect(command).toBeDefined();
    expect(command!.every((byte) => byte === 0)).toBe(true);
    expect(card.transmit).toHaveBeenCalledOnce();
    expect(card.reboot).toHaveBeenCalledOnce();
  });

  it('wraps a non-Error mutation rejection as its cause with truthful facts', async () => {
    const { card, service } = serviceFixture({ slot: '9c', status: 'empty' });
    const rejection = { kind: 'transport-closed' };
    card.transmit.mockRejectedValueOnce(rejection);

    const error = await mutateKey(service, 'generate', interaction(), false).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ cause: rejection, mutation: {
      attempted: true, confirmed: false, rebootFailed: false, restorationFailed: false,
    } });
    expect(card.transmit).toHaveBeenCalledOnce();
  });

  it('does not expose prompt failures through enabled generation diagnostics', async () => {
    vi.stubEnv('CCD_SIGNER_YUBIKEY_GENERATE_DIAGNOSTICS', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const failure = new Error('sensitive prompt details');
    const prompts = interaction();
    prompts.promptPin.mockRejectedValueOnce(failure);

    await expect(serviceFixture({ slot: '9c', status: 'empty' }).service.generateEd25519Key({
      force: false, interaction: prompts, pinPolicy: 'once', serial: '12345678', slot: '9c', touchPolicy: 'never',
    })).rejects.toBe(failure);

    expect(stderr.mock.calls.flat().join('')).not.toContain(failure.message);
  });

  it('wipes private-key command buffers after import while preserving verified result facts', async () => {
    const { card, service } = serviceFixture({ slot: '82', status: 'empty' });
    const privateKeyHex = '11'.repeat(32) as import('../../src/yubikeyService.js').Ed25519PrivateKeyHex;
    const importedKey = 'cd'.repeat(32) as Ed25519PublicKeyHex;
    let command: Buffer | undefined;
    card.transmit.mockImplementation(async (value: Buffer) => {
      command = value;
      return Buffer.alloc(0);
    });
    card.getSlotMetadata
      .mockResolvedValueOnce({ slot: '82', status: 'empty' })
      .mockResolvedValueOnce({
        algorithm: 0xe0, publicKeyTemplate: Buffer.from(`8620${importedKey}`, 'hex'), slot: '82', status: 'occupied',
      });

    await expect(service.importEd25519Key({
      force: false, interaction: interaction(), pinPolicy: 'always', privateKeyHex,
      publicKey: importedKey, serial: '12345678', slot: '82', touchPolicy: 'cached',
    })).resolves.toMatchObject({ publicKey: importedKey, replacedExistingKey: false });

    expect(command).toBeDefined();
    expect(command!.every((byte) => byte === 0)).toBe(true);
    expect(card.transmit).toHaveBeenCalledOnce();
  });

  it('rejects a post-import public-key mismatch after one mutation', async () => {
    const { card, service } = serviceFixture({ slot: '82', status: 'empty' });
    card.getSlotMetadata
      .mockResolvedValueOnce({ slot: '82', status: 'empty' })
      .mockResolvedValueOnce({
        algorithm: 0xe0, publicKeyTemplate: Buffer.from(`8620${PUBLIC_KEY}`, 'hex'), slot: '82', status: 'occupied',
      });

    const error = await service.importEd25519Key({
      force: false, interaction: interaction(), pinPolicy: 'once', privateKeyHex: '11'.repeat(32) as never,
      publicKey: 'cd'.repeat(32) as Ed25519PublicKeyHex, serial: '12345678', slot: '82', touchPolicy: 'never',
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({ message: expect.stringContaining('public key did not match'), mutation: {
      attempted: true, confirmed: true, rebootFailed: false, restorationFailed: false,
    } });
    expect(card.transmit).toHaveBeenCalledOnce();
  });

  it('checks the inventory key before one signing APDU', async () => {
    const { card, service } = serviceFixture();

    await expect(service.signEd25519Digest({
      devices: [{ kind: 'yubikey', serial: '12345678', slot: '9c' }],
      digest: Buffer.alloc(32, 1),
      publicKey: 'cd'.repeat(32) as Ed25519PublicKeyHex,
    })).rejects.toThrow('does not match signer inventory');

    expect(card.transmit).not.toHaveBeenCalled();
  });

  it('does not verify or prompt during noninteractive signing', async () => {
    const { card, service } = serviceFixture();
    card.transmit.mockRejectedValueOnce(new ApduStatusError(0x6982));

    await expect(service.signEd25519Digest({
      devices: [{ kind: 'yubikey', pinPolicy: 'once', serial: '12345678', slot: '9c' }],
      digest: Buffer.alloc(32, 1),
      publicKey: PUBLIC_KEY,
    })).rejects.toThrow('PIN verification required');

    expect(card.verifyPin).not.toHaveBeenCalled();
    expect(card.transmit).toHaveBeenCalledOnce();
  });
});

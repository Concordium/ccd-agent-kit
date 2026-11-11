import { describe, expect, it, vi } from 'vitest';
import { createIdentityYubiKeyService, IdentityHardwareError, PivDeviceNotFoundError } from '../../src/index.js';
import type { PivCardSession, PivTransport } from '../../src/index.js';
import { PRIVATE_DIAGNOSTIC, expectSanitized } from '../identityTestHelpers.js';
import {
  generationInput,
  hardware,
  importInput,
  occupied,
  OTHER_KEY,
  PRIVATE_KEY_HEX,
  PUBLIC_KEY,
  publicTemplate,
  SERIAL,
  sessionPool,
} from '../identityYubikeyHelpers.js';

async function rejects(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(IdentityHardwareError);
  await promise.catch((error: unknown) => expectSanitized(error, IdentityHardwareError, code));
}

function mutationEvents(events: string[], mutation: 'generate' | 'import') {
  return events.filter((event) => ['confirm', 'management', 'pin', mutation].includes(event));
}

type Mutation = 'generate' | 'import';

function mutationCase(mutation: Mutation) {
  const h = hardware();
  const service = createIdentityYubiKeyService(h.transport);
  if (mutation === 'generate') {
    const input = generationInput();
    return { mutation, h, input, run: () => service.generateRoot(input) };
  }
  const input = importInput();
  return { mutation, h, input, run: () => service.importRoot(input) };
}

function prepareEmpty({ mutation, h }: ReturnType<typeof mutationCase>, verifyImport = false) {
  h.card.getSlotMetadata.mockResolvedValueOnce({ slot: '9d', status: 'empty' } as ReturnType<typeof occupied>);
  if (mutation === 'import' && verifyImport) {
    h.card.getSlotMetadata.mockResolvedValueOnce({ ...occupied(), origin: 'imported' } as ReturnType<typeof occupied>);
  }
}

describe('identity native public observations', () => {
  it('sanitizes discovery failures', async () => {
    const h = hardware();
    h.withCards.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    await rejects(createIdentityYubiKeyService(h.transport).listDevices(), 'DEVICE_FAILED');
  });

  it('retains an unknown observation without inventing a key or algorithm', async () => {
    const h = hardware();
    h.card.getSlotMetadata.mockResolvedValue({ slot: '9d', status: 'unknown' });
    expect(await createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL)).toMatchObject({ status: 'unknown' });
  });

  it('does not expose a root key when occupied metadata has no public template', async () => {
    const h = hardware();
    h.card.getSlotMetadata.mockResolvedValue({ slot: '9d', status: 'occupied', algorithm: 0x11 });
    const result = await createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL);
    expect(result.status).toBe('occupied');
    expect(result.publicKey).toBeUndefined();
  });
  it('lists only public device facts through scoped shared transport discovery', async () => {
    const h = hardware();
    const result = await createIdentityYubiKeyService(h.transport).listDevices();
    expect(h.withCards).toHaveBeenCalledOnce();
    expect(result).toEqual([expect.objectContaining({ serial: SERIAL, readerName: h.card.readerName })]);
    expect(result[0]).not.toHaveProperty('transmit');
    expect(result[0]).not.toHaveProperty('reader');
    expect(h.card.transmit).not.toHaveBeenCalled();
    expect(h.card.verifyPin).not.toHaveBeenCalled();
  });

  it('ignores cards which do not select the PIV applet', async () => {
    const h = hardware();
    h.card.selectPiv.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    expect(await createIdentityYubiKeyService(h.transport).listDevices()).toEqual([]);
  });

  it.each(['', 'my-key', '-1', '12.3', ' 1234', '1234 '])('rejects selector %j before transport', async (serial) => {
    const h = hardware();
    await rejects(createIdentityYubiKeyService(h.transport).inspectRoot(serial), 'INVALID_DEVICE');
    expect(h.withSelectedCard).not.toHaveBeenCalled();
  });

  it('inspects fixed 9d without selecting the management applet', async () => {
    const h = hardware();
    h.card.getSlotMetadata.mockImplementation(async () => {
      h.events.push('metadata');
      return occupied();
    });
    const result = await createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL);
    expect(h.withSelectedCard).toHaveBeenCalledWith(SERIAL, expect.any(Function));
    expect(h.card.getSlotMetadata).toHaveBeenCalledExactlyOnceWith('9d');
    expect(h.events.lastIndexOf('select')).toBeLessThan(h.events.indexOf('metadata'));
    expect(h.card.getDeviceInfo).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      serial: SERIAL,
      slot: '9d',
      status: 'occupied',
      publicKey: PUBLIC_KEY.toString('hex'),
    });
    expect(h.card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(h.card.transmit).not.toHaveBeenCalled();
  });

  it.each([publicTemplate(), Buffer.concat([Buffer.from('7f4943', 'hex'), publicTemplate()])])(
    'accepts complete bare or wrapped P-256 public templates',
    async (publicKeyTemplate) => {
      const h = hardware();
      h.card.getSlotMetadata.mockResolvedValue({ ...occupied(), publicKeyTemplate });
      expect((await createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL)).publicKey).toBe(
        PUBLIC_KEY.toString('hex'),
      );
    },
  );

  it.each([
    Buffer.from('864104', 'hex'),
    publicTemplate(Buffer.alloc(65, 4)),
    Buffer.concat([publicTemplate(), Buffer.from('00', 'hex')]),
  ])('never labels malformed or off-curve metadata as a usable root', async (publicKeyTemplate) => {
    const h = hardware();
    h.card.getSlotMetadata.mockResolvedValue({ ...occupied(), publicKeyTemplate });
    const result = await createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL);
    expect(result.publicKey).toBeUndefined();
    expect(result.status).not.toBe('empty');
  });

  it('sanitizes transport failures without retaining source errors', async () => {
    const h = hardware();
    h.withSelectedCard.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    await rejects(createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL), 'DEVICE_FAILED');
    expect(h.withSelectedCard).toHaveBeenCalledOnce();
  });

  it.each([
    [new PivDeviceNotFoundError(SERIAL), 'DEVICE_MISSING'],
    [Object.assign(new Error(PRIVATE_DIAGNOSTIC), { code: 'SCARD_E_SHARING_VIOLATION' }), 'DEVICE_BUSY'],
  ])('maps inspect transport failure %# to sanitized %s', async (failure, code) => {
    const h = hardware();
    h.withSelectedCard.mockRejectedValue(failure);

    await rejects(createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL), code);
    expect(h.withSelectedCard).toHaveBeenCalledOnce();
    expect(h.card.selectPiv).not.toHaveBeenCalled();
    expect(h.card.verifyPin).not.toHaveBeenCalled();
    expect(h.card.transmit).not.toHaveBeenCalled();
  });

  it('retains every discovered serial when a session pool is supplied', async () => {
    const first = hardware();
    const second = hardware();
    second.card.readerName = 'Second YubiKey reader';
    second.card.getSerial.mockResolvedValue('87654321');
    second.card.getVersion.mockResolvedValue('5.7.2');
    const transport = {
      withCards<T>(callback: (cards: PivCardSession[]) => Promise<T> | T): Promise<T> {
        return Promise.resolve(callback([first.card, second.card]));
      },
      withSelectedCard<T>(
        _serial: string | undefined,
        callback: (card: PivCardSession) => Promise<T>,
      ): Promise<T> {
        return callback(first.card);
      },
      watchDevices: vi.fn(async () => ({ close() {} })),
    } satisfies PivTransport;
    const sessions = sessionPool(first.card);

    const devices = await createIdentityYubiKeyService(transport, sessions.pool).listDevices();

    expect(devices).toEqual([
      { readerName: first.card.readerName, serial: SERIAL, firmwareVersion: '5.8.0' },
      { readerName: second.card.readerName, serial: '87654321', firmwareVersion: '5.7.2' },
    ]);
    expect(sessions.pool.retain.mock.calls).toEqual([[SERIAL], ['87654321']]);
  });

  it('sanitizes a pooled retain failure after discovery', async () => {
    const h = hardware();
    const sessions = sessionPool(h.card);
    sessions.pool.retain.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));

    await rejects(createIdentityYubiKeyService(h.transport, sessions.pool).listDevices(), 'DEVICE_FAILED');

    expect(sessions.pool.retain).toHaveBeenCalledExactlyOnceWith(SERIAL);
  });

  it('routes root inspection through the retained pool instead of direct transport', async () => {
    const h = hardware();
    const sessions = sessionPool(h.card);

    await createIdentityYubiKeyService(h.transport, sessions.pool).inspectRoot(SERIAL);

    expect(sessions.withCard).toHaveBeenCalledExactlyOnceWith(SERIAL, expect.any(Function));
    expect(h.withSelectedCard).not.toHaveBeenCalled();
  });

  it('closes the entire supplied pool and safely closes without one', async () => {
    const h = hardware();
    const sessions = sessionPool(h.card);

    await createIdentityYubiKeyService(h.transport, sessions.pool).close!();
    await expect(createIdentityYubiKeyService(h.transport).close!()).resolves.toBeUndefined();

    expect(sessions.pool.close).toHaveBeenCalledOnce();
  });

  it('sanitizes pool close failures without retaining private diagnostics', async () => {
    const h = hardware();
    const sessions = sessionPool(h.card);
    sessions.pool.close.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));

    await rejects(createIdentityYubiKeyService(h.transport, sessions.pool).close!(), 'DEVICE_FAILED');

    expect(sessions.pool.close).toHaveBeenCalledOnce();
  });
});

describe('identity PIN lifecycle failure boundary', () => {
  it.each([
    ['status', 'select'], ['status', 'operation'],
    ['unlock', 'select'], ['unlock', 'operation'],
    ['lock', 'select'], ['lock', 'operation'],
  ] as const)('sanitizes %s %s failure without retry or unrelated card operations', async (method, stage) => {
    const h = hardware();
    const service = createIdentityYubiKeyService(h.transport);
    if (stage === 'select') h.card.selectPiv.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    else if (method === 'status') h.card.getPinStatus.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    else if (method === 'unlock') h.card.verifyPin.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    else h.card.clearPinVerification.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));

    const operation = method === 'status'
      ? service.pinStatus(SERIAL)
      : method === 'unlock'
        ? service.pinUnlock(SERIAL, async () => '123456')
        : service.pinLock(SERIAL);
    await rejects(operation, 'DEVICE_FAILED');

    expect(h.withSelectedCard).toHaveBeenCalledOnce();
    expect(h.card.selectPiv).toHaveBeenCalledOnce();
    expect(h.card.getPinStatus).toHaveBeenCalledTimes(stage === 'operation' && method === 'status' ? 1 : 0);
    expect(h.card.verifyPin).toHaveBeenCalledTimes(stage === 'operation' && method === 'unlock' ? 1 : 0);
    expect(h.card.clearPinVerification).toHaveBeenCalledTimes(stage === 'operation' && method === 'lock' ? 1 : 0);
    expect(h.card.transmit).not.toHaveBeenCalled();
    expect(h.card.reboot).not.toHaveBeenCalled();
  });
});

describe.each(['generate', 'import'] as const)('identity root %s common lifecycle', (mutation) => {
  it.each([
    ['pinPolicy', 'default'],
    ['pinPolicy', undefined],
    ['touchPolicy', 'default'],
    ['touchPolicy', undefined],
  ])('requires explicit valid %s %j before hardware access', async (field, value) => {
    const test = mutationCase(mutation);
    Object.assign(test.input, { [field]: value });
    await rejects(test.run(), 'INVALID_POLICY');
    expect(test.h.withSelectedCard).not.toHaveBeenCalled();
  });

  it.each([
    ['occupied', false, 'SLOT_OCCUPIED'],
    ['unknown', false, 'OCCUPANCY_UNKNOWN'],
    ['unknown', true, 'OCCUPANCY_UNKNOWN'],
  ] as const)('fails closed on %s occupancy with force=%s', async (status, force, code) => {
    const test = mutationCase(mutation);
    test.h.card.getSlotMetadata.mockResolvedValue({ ...occupied(), status } as ReturnType<typeof occupied>);
    test.input.force = force;
    await rejects(test.run(), code);
    expect(test.input.interaction.confirm).not.toHaveBeenCalled();
    expect(test.h.card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(test.h.card.verifyPin).not.toHaveBeenCalled();
    expect(test.h.card.transmit).not.toHaveBeenCalled();
  });

  it.each([
    ['required', 1, 1],
    ['verified', 2, 0],
  ] as const)('restores an initially %s PIN state after reboot', async (status, selectedCalls, clearCalls) => {
    const test = mutationCase(mutation);
    prepareEmpty(test, true);
    test.h.card.getPinStatus.mockResolvedValue(
      status === 'required' ? { status, retries: 3 } : { status },
    );
    await test.run();
    expect(test.input.interaction.promptPin).toHaveBeenCalledOnce();
    expect(test.h.card.reboot).toHaveBeenCalledOnce();
    expect(test.h.withSelectedCard).toHaveBeenCalledTimes(selectedCalls);
    expect(test.h.card.verifyPin).toHaveBeenCalledTimes(status === 'verified' ? 2 : 1);
    expect(test.h.card.clearPinVerification).toHaveBeenCalledTimes(clearCalls);
  });

  it.each(['authentication', 'pin'])('does not mutate after %s failure', async (stage) => {
    const test = mutationCase(mutation);
    prepareEmpty(test);
    const authorization = stage === 'authentication' ? test.h.card.authenticateManagementKey : test.h.card.verifyPin;
    authorization.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    await rejects(test.run(), 'DEVICE_FAILED');
    expect(authorization).toHaveBeenCalledOnce();
    expect(test.h.card.transmit).not.toHaveBeenCalled();
    expect(test.h.card.reboot).not.toHaveBeenCalled();
  });

  const uncertaintyFailures = [
    ...(mutation === 'generate' ? ['malformed-response'] : []),
    'mismatch',
    'policy',
    'algorithm',
    'missing-metadata',
    'transmit-failure',
  ];
  it.each(uncertaintyFailures)('reports uncertain mutation, without retries, after %s', async (failure) => {
    const test = mutationCase(mutation);
    prepareEmpty(test);
    if (failure === 'malformed-response') test.h.card.transmit.mockResolvedValue(Buffer.from('7f4900', 'hex'));
    if (failure === 'transmit-failure') test.h.card.transmit.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    if (failure === 'mismatch') {
      test.h.card.getSlotMetadata.mockResolvedValueOnce({
        ...occupied(OTHER_KEY),
        ...(mutation === 'import' ? { origin: 'imported' as const } : {}),
      });
    }
    if (failure === 'policy') test.h.card.getSlotMetadata.mockResolvedValueOnce({ ...occupied(), pinPolicy: 'never' });
    if (failure === 'algorithm') test.h.card.getSlotMetadata.mockResolvedValueOnce({ ...occupied(), algorithm: 0x16 });
    if (failure === 'missing-metadata') {
      test.h.card.getSlotMetadata.mockRejectedValueOnce(new Error(PRIVATE_DIAGNOSTIC));
    }
    await rejects(test.run(), mutation === 'generate' ? 'GENERATION_UNCERTAIN' : 'IMPORT_UNCERTAIN');
    expect(test.h.card.transmit).toHaveBeenCalledOnce();
    if (mutation === 'import') expect(test.h.card.reboot).toHaveBeenCalledOnce();
  });

  it('preserves mutation uncertainty while reporting reboot and PIN restoration failures', async () => {
    const test = mutationCase(mutation);
    prepareEmpty(test);
    test.h.card.getPinStatus.mockResolvedValue({ status: 'verified' });
    test.h.card.transmit.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    test.h.card.reboot.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    test.h.withSelectedCard
      .mockImplementationOnce(async (_serial, callback) => callback(test.h.card))
      .mockRejectedValueOnce(new Error(PRIVATE_DIAGNOSTIC));
    const error = await test.run().catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: mutation === 'generate' ? 'GENERATION_UNCERTAIN' : 'IMPORT_UNCERTAIN',
      mutation: { attempted: true, confirmed: false, rebootFailed: true, restorationFailed: true },
    });
    expect(test.h.card.transmit).toHaveBeenCalledOnce();
  });
});

describe('identity root generation authorization and verification', () => {
  it('fails closed before authentication when an occupied root has unusable public material', async () => {
      const h = hardware();
      h.card.getSlotMetadata.mockResolvedValue({
        ...occupied(),
        publicKeyTemplate: Buffer.alloc(0),
      });
      await rejects(
        createIdentityYubiKeyService(h.transport).generateRoot({ ...generationInput(), force: true }),
        'OCCUPANCY_UNKNOWN',
      );
      expect(h.card.authenticateManagementKey).not.toHaveBeenCalled();
      expect(h.card.transmit).not.toHaveBeenCalled();
  });
  it('requires destructive confirmation before management/PIN authorization and generates exactly once', async () => {
    const h = hardware();
    const input = { ...generationInput(), force: true };
    input.interaction.confirm = vi.fn(async () => {
      h.events.push('confirm');
      return true;
    });
    h.card.transmit.mockImplementation(async () => {
      h.events.push('generate');
      return Buffer.concat([Buffer.from('7f4943', 'hex'), publicTemplate()]);
    });
    const result = await createIdentityYubiKeyService(h.transport).generateRoot(input);
    expect(input.interaction.confirm).toHaveBeenCalledWith(expect.stringContaining(SERIAL));
    expect(mutationEvents(h.events, 'generate')).toEqual(['confirm', 'management', 'pin', 'generate']);
    expect(h.withSelectedCard).toHaveBeenCalledWith(SERIAL, expect.any(Function));
    expect(h.card.authenticateManagementKey).toHaveBeenCalledWith(input.interaction.promptManagementKey);
    expect(h.card.verifyPin).toHaveBeenCalledWith(expect.any(Function));
    expect(input.interaction.promptPin).toHaveBeenCalledOnce();
    expect(h.card.transmit).toHaveBeenCalledOnce();
    const command = h.card.transmit.mock.calls[0]![0];
    expect(command.subarray(0, 5).toString('hex')).toBe('0047009d0b');
    expect(command.subarray(5, 16).toString('hex')).toBe('ac09800111aa0102ab0102');
    expect(result).toMatchObject({
      status: 'occupied',
      publicKey: PUBLIC_KEY.toString('hex'),
      replacedExistingKey: true,
    });
  });

  it('cancellation leaves the occupied slot untouched', async () => {
    const h = hardware();
    const input = { ...generationInput(), force: true };
    input.interaction.confirm = vi.fn(async () => false);
    await rejects(createIdentityYubiKeyService(h.transport).generateRoot(input), 'CANCELLED');
    expect(h.card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(h.card.transmit).not.toHaveBeenCalled();
  });

  it('provisions a confirmed empty slot without destructive confirmation', async () => {
    const h = hardware();
    h.card.getSlotMetadata.mockResolvedValueOnce({ slot: '9d', status: 'empty' } as ReturnType<typeof occupied>);
    const input = generationInput();
    const result = await createIdentityYubiKeyService(h.transport).generateRoot(input);
    expect(input.interaction.confirm).not.toHaveBeenCalled();
    expect(result.replacedExistingKey).toBe(false);
  });

  it.each([
    ['never', 'never', 1, 1],
    ['never', 'cached', 1, 3],
    ['never', 'always', 1, 2],
    ['once', 'never', 2, 1],
    ['once', 'cached', 2, 3],
    ['once', 'always', 2, 2],
    ['always', 'never', 3, 1],
    ['always', 'cached', 3, 3],
    ['always', 'always', 3, 2],
  ] as const)('encodes explicit PIN %s and touch %s policies', async (pinPolicy, touchPolicy, pinByte, touchByte) => {
    const h = hardware();
    h.card.getSlotMetadata
      .mockResolvedValueOnce({ slot: '9d', status: 'empty' } as ReturnType<typeof occupied>)
      .mockResolvedValueOnce({ ...occupied(), pinPolicy, touchPolicy } as ReturnType<typeof occupied>);
    await createIdentityYubiKeyService(h.transport).generateRoot({ ...generationInput(), pinPolicy, touchPolicy });
    const command = h.card.transmit.mock.calls[0]![0];
    expect(command.subarray(5, 16)).toEqual(
      Buffer.from([0xac, 9, 0x80, 1, 0x11, 0xaa, 1, pinByte, 0xab, 1, touchByte]),
    );
  });

});

describe('identity root P-256 import authorization and verification', () => {
  it.each([
    '',
    '01',
    'gg'.repeat(32),
    '00'.repeat(32),
    'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    'ff'.repeat(32),
  ])('rejects invalid private scalar %j before transport or authentication', async (privateKeyHex) => {
    const h = hardware();
    await rejects(
      createIdentityYubiKeyService(h.transport).importRoot({ ...importInput(), privateKeyHex }),
      'INVALID_PRIVATE_KEY',
    );
    expect(h.withSelectedCard).not.toHaveBeenCalled();
    expect(h.card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(h.card.transmit).not.toHaveBeenCalled();
  });

  it('imports scalar-derived P-256 public material into fixed slot 9d and returns verified facts', async () => {
    const h = hardware();
    let transmitted: Buffer | undefined;
    h.card.transmit.mockImplementation(async (command) => {
      transmitted = Buffer.from(command);
      return Buffer.alloc(0);
    });
    h.card.getSlotMetadata
      .mockResolvedValueOnce({ slot: '9d', status: 'empty' } as ReturnType<typeof occupied>)
      .mockResolvedValueOnce({ ...occupied(), origin: 'imported' } as ReturnType<typeof occupied>);
    const input = importInput();

    const result = await createIdentityYubiKeyService(h.transport).importRoot(input);

    expect(h.card.authenticateManagementKey).toHaveBeenCalledWith(input.interaction.promptManagementKey);
    expect(input.interaction.promptPin).toHaveBeenCalledOnce();
    expect(h.card.transmit).toHaveBeenCalledOnce();
    expect(transmitted!.toString('hex')).toBe(`00fe119d280620${PRIVATE_KEY_HEX}aa0102ab010200`);
    expect(h.card.transmit.mock.calls[0]![0].every((byte) => byte === 0)).toBe(true);
    expect(result).toMatchObject({
      serial: SERIAL,
      slot: '9d',
      status: 'occupied',
      origin: 'imported',
      publicKey: PUBLIC_KEY.toString('hex'),
      replacedExistingKey: false,
    });
  });

  it('requires typed destructive confirmation before replacing a valid occupied root', async () => {
    const h = hardware();
    const input = { ...importInput(), force: true };
    input.interaction.confirm = vi.fn(async () => false);

    await rejects(createIdentityYubiKeyService(h.transport).importRoot(input), 'CANCELLED');

    expect(input.interaction.confirm).toHaveBeenCalledWith(expect.stringContaining(`${SERIAL} 9d`));
    expect(h.card.authenticateManagementKey).not.toHaveBeenCalled();
    expect(h.card.transmit).not.toHaveBeenCalled();
  });

  it('confirms before authorization and imports exactly once when replacing an occupied root', async () => {
    const h = hardware();
    h.card.getSlotMetadata
      .mockResolvedValueOnce(occupied())
      .mockResolvedValueOnce({ ...occupied(), origin: 'imported' });
    const input = { ...importInput(), force: true };
    input.interaction.confirm = vi.fn(async () => {
      h.events.push('confirm');
      return true;
    });
    h.card.transmit.mockImplementation(async () => {
      h.events.push('import');
      return Buffer.alloc(0);
    });

    const result = await createIdentityYubiKeyService(h.transport).importRoot(input);

    expect(input.interaction.confirm).toHaveBeenCalledWith(expect.stringContaining(`${SERIAL} 9d`));
    expect(mutationEvents(h.events, 'import')).toEqual(['confirm', 'management', 'pin', 'import']);
    expect(h.card.authenticateManagementKey).toHaveBeenCalledWith(input.interaction.promptManagementKey);
    expect(h.card.verifyPin).toHaveBeenCalledWith(expect.any(Function));
    expect(h.card.transmit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'occupied',
      origin: 'imported',
      publicKey: PUBLIC_KEY.toString('hex'),
      replacedExistingKey: true,
    });
  });

});

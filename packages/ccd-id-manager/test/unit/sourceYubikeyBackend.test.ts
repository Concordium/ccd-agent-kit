import { IdentityHardwareError,type IdentityRootInspection,type IdentityYubiKeyService } from '@ccd-agent-kit/piv-utils';
import { describe,expect,it,vi } from 'vitest';
import { createYubiKeySourceBackend } from '../../src/core/sources/yubikey.js';
import { PRIVATE_DIAGNOSTIC } from '../helpers.js';
import { PUBLIC_KEY,SERIAL } from '../yubikeyHelpers.js';

const SOURCE_ID = 'ir:y27dru5wlwjzay6';
function fixture() {
  const agreement = { agree: vi.fn() };
  const hardware = {
    inspectRoot: vi.fn<IdentityYubiKeyService['inspectRoot']>(async () => ({
      serial: SERIAL, readerName: 'reader', slot: '9d', status: 'occupied' as const,
      algorithm: '0x11', publicKey: PUBLIC_KEY.toString('hex'), pinPolicy: 'once' as const,
      touchPolicy: 'cached' as const, pinStatus: { status: 'required' as const, retries: 3 },
    })),
    listDevices: vi.fn<IdentityYubiKeyService['listDevices']>(),
    generateRoot: vi.fn<IdentityYubiKeyService['generateRoot']>(),
    importRoot: vi.fn<IdentityYubiKeyService['importRoot']>(),
    pinStatus: vi.fn<IdentityYubiKeyService['pinStatus']>(),
    pinUnlock: vi.fn<IdentityYubiKeyService['pinUnlock']>(async () => {}),
    pinLock: vi.fn<IdentityYubiKeyService['pinLock']>(async () => {}),
    createAgreement: vi.fn<IdentityYubiKeyService['createAgreement']>(() => agreement),
  } satisfies IdentityYubiKeyService;
  return { hardware, agreement, backend: createYubiKeySourceBackend(hardware) };
}

describe('YubiKey PIV identity-source adapter', () => {
  it('wraps only existing strict root inspection for read-only status', async () => {
    const h = fixture();
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({
      status: 'present', rootPublicKey: PUBLIC_KEY.toString('hex'), authorization: 'locked',
      pinPolicy: 'once', touchPolicy: 'cached',
    });
    expect(h.hardware.inspectRoot).toHaveBeenCalledExactlyOnceWith(SERIAL);
    expect(h.hardware.listDevices).not.toHaveBeenCalled();
    expect(h.hardware.generateRoot).not.toHaveBeenCalled();
    expect(h.hardware.createAgreement).not.toHaveBeenCalled();
  });

  it.each([
    ['never', 'unlocked'], ['once', 'locked'], ['always', 'locked'],
  ] as const)('maps YubiKey PIN policy %s to generic %s authorization', async (pinPolicy, authorization) => {
    const h = fixture();
    h.hardware.inspectRoot.mockResolvedValue({
      serial: SERIAL, readerName: 'reader', slot: '9d', status: 'occupied',
      publicKey: PUBLIC_KEY.toString('hex'), pinPolicy, touchPolicy: 'always',
      pinStatus: { status: 'required', retries: 3 },
    });
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({
      status: 'present', rootPublicKey: PUBLIC_KEY.toString('hex'), authorization,
      pinPolicy, touchPolicy: 'always',
    });
  });

  it('rejects present root metadata without a supported PIN policy instead of inventing authorization', async () => {
    const h = fixture();
    h.hardware.inspectRoot.mockResolvedValue({
      serial: SERIAL, readerName: 'reader', slot: '9d', status: 'occupied', publicKey: PUBLIC_KEY.toString('hex'),
      pinStatus: { status: 'required', retries: 3 },
    });
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({
      status: 'unavailable', reason: 'UNSUPPORTED_METADATA',
    });
    expect(h.hardware.createAgreement).not.toHaveBeenCalled();
    expect(h.hardware.generateRoot).not.toHaveBeenCalled();
  });

  it('omits absent optional touch policy from a usable observation', async () => {
    const h = fixture();
    h.hardware.inspectRoot.mockResolvedValue({
      serial: SERIAL, readerName: 'reader', slot: '9d', status: 'occupied',
      publicKey: PUBLIC_KEY.toString('hex'), pinPolicy: 'once', pinStatus: { status: 'required', retries: 3 },
    });
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({
      status: 'present', rootPublicKey: PUBLIC_KEY.toString('hex'), authorization: 'locked', pinPolicy: 'once',
    });
  });

  it.each([
    [{ status: 'empty' }, 'UNSUPPORTED_METADATA'],
    [{ status: 'unknown' }, 'UNSUPPORTED_METADATA'],
    [{ status: 'occupied' }, 'UNSUPPORTED_METADATA'],
  ] satisfies Array<[Partial<IdentityRootInspection>, string]>)('does not invent availability for unusable slot metadata %#', async (change, reason) => {
    const h = fixture();
    h.hardware.inspectRoot.mockResolvedValue(Object.assign({
      serial: SERIAL, readerName: 'reader', slot: '9d' as const, status: 'occupied' as const,
      pinStatus: { status: 'required' as const, retries: 3 },
    }, change));
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({ status: 'unavailable', reason });
    expect(h.hardware.generateRoot).not.toHaveBeenCalled();
    expect(h.hardware.createAgreement).not.toHaveBeenCalled();
  });

  it('sanitizes hardware inspection errors into an unreadable observation', async () => {
    const h = fixture();
    h.hardware.inspectRoot.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    const result = await h.backend.inspect({ serial: SERIAL });
    expect(result).toEqual({ status: 'unavailable', reason: 'UNREADABLE' });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_DIAGNOSTIC);
  });

  it.each([
    ['DEVICE_MISSING', 'DEVICE_MISSING'],
    ['DEVICE_BUSY', 'DEVICE_BUSY'],
    ['ROOT_UNAVAILABLE', 'UNSUPPORTED_METADATA'],
  ] as const)('maps stable hardware %s without exposing backend diagnostics', async (code, reason) => {
    const h = fixture();
    h.hardware.inspectRoot.mockRejectedValue(new IdentityHardwareError(code as never));
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({ status: 'unavailable', reason });
    expect(h.hardware.generateRoot).not.toHaveBeenCalled();
  });

  it('maps other sanitized hardware failures to unreadable', async () => {
    const h = fixture();
    h.hardware.inspectRoot.mockRejectedValue(new IdentityHardwareError('DEVICE_FAILED'));
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({ status: 'unavailable', reason: 'UNREADABLE' });
  });

  it('delegates agreement with the enrolled locator and expected pin only on explicit request', () => {
    const h = fixture();
    const expectedPublicKey = Buffer.from(PUBLIC_KEY);
    const promptPin = vi.fn(async () => '123456');
    const agreement = h.backend.createAgreement({ sourceId: SOURCE_ID, locator: { serial: SERIAL }, expectedPublicKey, promptPin });
    expect(agreement).toHaveProperty('agree', expect.any(Function));
    expect(h.hardware.createAgreement).toHaveBeenCalledExactlyOnceWith({
      serial: SERIAL, expectedPublicKey, promptPin,
    });
    expect(h.hardware.generateRoot).not.toHaveBeenCalled();
  });

  it('omits an absent PIN callback when delegating agreement', () => {
    const h = fixture();
    const expectedPublicKey = Buffer.from(PUBLIC_KEY);
    const agreement = h.backend.createAgreement({ sourceId: SOURCE_ID, locator: { serial: SERIAL }, expectedPublicKey });
    expect(agreement).toHaveProperty('agree', expect.any(Function));
    expect(h.hardware.createAgreement).toHaveBeenCalledExactlyOnceWith({
      serial: SERIAL, expectedPublicKey,
    });
  });

  it('reports PIN-once authorization from fresh device state', async () => {
    const h = fixture();
    h.hardware.inspectRoot.mockResolvedValue({
      serial: SERIAL, readerName: 'reader', slot: '9d', status: 'occupied',
      publicKey: PUBLIC_KEY.toString('hex'), pinPolicy: 'once', pinStatus: { status: 'verified' },
    });
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toMatchObject({ authorization: 'unlocked' });
  });

  it('caches public slot observations while refreshing PIN status on source reads', async () => {
    const h = fixture();
    h.hardware.pinStatus.mockResolvedValueOnce({ status: 'required', retries: 3 }).mockResolvedValueOnce({ status: 'verified' });

    await h.backend.refresh!([{ serial: SERIAL }]);
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toMatchObject({ authorization: 'locked' });
    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toMatchObject({ authorization: 'unlocked' });

    expect(h.hardware.inspectRoot).toHaveBeenCalledOnce();
    expect(h.hardware.pinStatus).toHaveBeenCalledTimes(2);
  });

  it('drops removed cached locations and only refreshes currently referenced devices', async () => {
    const h = fixture();
    await h.backend.refresh!([{ serial: SERIAL }, { serial: '87654321' }]);
    await h.backend.retain!([{ serial: '87654321' }]);

    await expect(h.backend.inspect({ serial: SERIAL })).resolves.toEqual({ status: 'unavailable', reason: 'DEVICE_MISSING' });
    expect(h.hardware.inspectRoot).toHaveBeenCalledTimes(2);
  });
});

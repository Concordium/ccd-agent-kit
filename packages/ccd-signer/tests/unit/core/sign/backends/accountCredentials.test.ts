import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ed25519SignerKeyRef, type AccountCredentialObservation, type SignerInventoryKeyEntry } from '@ccd-agent-kit/config-utils';
import type {
  GenerateYubiKeyInput,
  GenerateYubiKeyResult,
  ImportYubiKeyInput,
  ImportYubiKeyResult,
  SignYubiKeyDigestInput,
  UnlockYubiKeyInput,
  UnlockYubiKeyResult,
  YubiKeyDeviceSummary,
  YubiKeyInspection,
  YubiKeyService,
} from '@ccd-agent-kit/piv-utils';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import type { VisibleSignerInventoryKey } from '../../../../../src/core/modules/keyVisibility.js';
import type { signInventoryEntryEd25519Digest as SignInventoryEntryEd25519Digest } from '../../../../../src/core/modules/signing.js';

const collaborators = vi.hoisted(() => ({
  getEntry: vi.fn<(publicKey: Ed25519PublicKeyHex) => SignerInventoryKeyEntry | undefined>(),
  listKeys: vi.fn<() => VisibleSignerInventoryKey[]>(),
  sign: vi.fn<typeof SignInventoryEntryEd25519Digest>(),
}));

vi.mock('../../../../../src/core/modules/keyVisibility.js', () => ({
  getVisibleSignerInventoryEntry: collaborators.getEntry,
  listVisibleSignerInventoryKeys: collaborators.listKeys,
}));
vi.mock('../../../../../src/core/modules/signing.js', () => ({
  signInventoryEntryEd25519Digest: collaborators.sign,
}));

import {
  AccountCredentialsSigningBackend,
  hasAvailableObservedCredentialKey,
} from '../../../../../src/core/sign/backends/accountCredentials.js';
import { testEd25519PublicKeyHex } from '../../../../helpers/ed25519.js';

const FIRST_KEY = testEd25519PublicKeyHex('11'.repeat(32));
const SECOND_KEY = testEd25519PublicKeyHex('22'.repeat(32));
const DIGEST = new Uint8Array([1, 2, 3]);
const FIRST_ENTRY = inventoryEntry('first');
const SECOND_ENTRY = inventoryEntry('second');

describe('AccountCredentialsSigningBackend', () => {
  beforeEach(() => {
    collaborators.getEntry.mockImplementation((publicKey) => publicKey === FIRST_KEY ? FIRST_ENTRY : publicKey === SECOND_KEY ? SECOND_ENTRY : undefined);
    collaborators.listKeys.mockReturnValue([visibleKey(FIRST_KEY, FIRST_ENTRY), visibleKey(SECOND_KEY, SECOND_ENTRY)]);
    collaborators.sign.mockImplementation(async ({ publicKey }) => publicKey === FIRST_KEY ? 'aa'.repeat(64) : 'bb'.repeat(64));
  });

  afterEach(() => vi.clearAllMocks());

  it('returns no signatures without consulting inventory when no automatic signatures are missing', async () => {
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ missingSignatures: 0 }))).resolves.toEqual({});
    expect(collaborators.listKeys).not.toHaveBeenCalled();
    expect(collaborators.sign).not.toHaveBeenCalled();
  });

  it('automatically skips existing signatures and respects the requested signature limit', async () => {
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY, SECOND_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({
      existingSignatures: { 0: { 0: 'existing' } },
      maxSignatures: 2,
      missingSignatures: 2,
    }))).resolves.toEqual({ 0: { 1: 'bb'.repeat(64) } });
    expect(collaborators.sign).toHaveBeenCalledTimes(1);
    expect(collaborators.sign).toHaveBeenCalledWith(expect.objectContaining({ publicKey: SECOND_KEY }));
  });

  it('signs each explicitly selected credential/key pair', async () => {
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY, SECOND_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ keys: ['0:1', '0:0'], missingSignatures: 0 }))).resolves.toEqual({
      0: { 0: 'aa'.repeat(64), 1: 'bb'.repeat(64) },
    });
    expect(collaborators.sign.mock.calls.map(([input]) => input.publicKey)).toEqual([SECOND_KEY, FIRST_KEY]);
  });

  it('reports automatic selection exhaustion after existing signatures are removed', async () => {
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ existingSignatures: { 0: { 0: 'existing' } } })))
      .rejects.toThrow(/no available signing keys remain/i);
    expect(collaborators.sign).not.toHaveBeenCalled();
  });

  it('reports when no observed key is available for automatic selection', async () => {
    collaborators.listKeys.mockReturnValue([]);
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request())).rejects.toThrow(/no available signing keys remain/i);
    expect(collaborators.sign).not.toHaveBeenCalled();
  });

  it('rejects an unavailable explicitly selected key without attempting to sign', async () => {
    collaborators.listKeys.mockReturnValue([]);
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ keys: ['0:0'] }))).rejects.toThrow(/not available/i);
    expect(collaborators.sign).not.toHaveBeenCalled();
  });

  it('rejects a malformed explicit credential/key selector without attempting to sign', async () => {
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ keys: ['0'] }))).rejects.toBeInstanceOf(Error);
    expect(collaborators.sign).not.toHaveBeenCalled();
  });

  it('rejects an explicitly selected key that already has a signature', async () => {
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ keys: ['0:0'], existingSignatures: { 0: { 0: 'existing' } } })))
      .rejects.toThrow(/already has a signature/i);
    expect(collaborators.sign).not.toHaveBeenCalled();
  });

  it('propagates a locked-key failure from the signing collaborator', async () => {
    collaborators.sign.mockRejectedValueOnce(new Error('ENCRYPTED_STORAGE_LOCKED'));
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request())).rejects.toThrow('ENCRYPTED_STORAGE_LOCKED');
  });

  it('routes the selected entry, digest, and hardware collaborators to signing', async () => {
    const service = new FakeYubiKeyService();
    const promptPin = async () => '123456';
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY), service, { promptPin });

    await backend.createSignature(request());

    expect(collaborators.sign).toHaveBeenCalledWith({
      digest: DIGEST,
      entry: FIRST_ENTRY,
      publicKey: FIRST_KEY,
      yubiKeyInteraction: { promptPin },
      yubiKeyService: service,
    });
  });

  it('rechecks key authorization between awaited signatures', async () => {
    collaborators.sign.mockImplementationOnce(async () => {
      collaborators.getEntry.mockImplementation((publicKey) => publicKey === FIRST_KEY ? FIRST_ENTRY : undefined);
      return 'aa'.repeat(64);
    });
    const backend = new AccountCredentialsSigningBackend(observation(FIRST_KEY, SECOND_KEY), new FakeYubiKeyService());

    await expect(backend.createSignature(request({ maxSignatures: 2, missingSignatures: 2 }))).rejects.toThrow(/not available/i);
    expect(collaborators.sign).toHaveBeenCalledTimes(1);
  });

  it('reports availability only when an observed public key is visible', () => {
    expect(hasAvailableObservedCredentialKey(observation(FIRST_KEY))).toBe(true);
    collaborators.listKeys.mockReturnValue([visibleKey(SECOND_KEY, SECOND_ENTRY)]);
    expect(hasAvailableObservedCredentialKey(observation(FIRST_KEY))).toBe(false);
  });
});

function request(input: Partial<Parameters<AccountCredentialsSigningBackend['createSignature']>[0]> = {}) {
  return { digest: DIGEST, existingSignatures: {}, missingSignatures: 1, role: 'sender' as const, ...input };
}

function observation(...publicKeys: Ed25519PublicKeyHex[]): AccountCredentialObservation {
  return {
    accountThreshold: '1',
    credentials: {
      0: {
        keys: Object.fromEntries(publicKeys.map((publicKey, index) => [index, { publicKey, scheme: 'Ed25519' }])),
        threshold: '1',
      },
    },
    sourceBlock: { hash: '33'.repeat(32), height: '1', time: '2026-10-25T00:00:00.000Z' },
  };
}

function inventoryEntry(ref: string): SignerInventoryKeyEntry {
  return { backends: [{ backend: { ref }, createdAt: '', signingModule: ref, updatedAt: '' }], createdAt: '', scheme: 'Ed25519', updatedAt: '' };
}

function visibleKey(publicKey: Ed25519PublicKeyHex, entry: SignerInventoryKeyEntry): VisibleSignerInventoryKey {
  return { backends: entry.backends, entry, keyRef: ed25519SignerKeyRef(publicKey), publicKey };
}

class FakeYubiKeyService implements YubiKeyService {
  public async listDevices(): Promise<YubiKeyDeviceSummary[]> { return []; }
  public async inspectDevice(): Promise<YubiKeyInspection> { throw new Error('not used'); }
  public async listAndInspectDeviceKeys(): Promise<{ devices: YubiKeyDeviceSummary[]; inspections: YubiKeyInspection[] }> { return { devices: [], inspections: [] }; }
  public async generateEd25519Key(_input: GenerateYubiKeyInput): Promise<GenerateYubiKeyResult> { throw new Error('not used'); }
  public async importEd25519Key(_input: ImportYubiKeyInput): Promise<ImportYubiKeyResult> { throw new Error('not used'); }
  public async unlockDevice(_input: UnlockYubiKeyInput): Promise<UnlockYubiKeyResult> { throw new Error('not used'); }
  public async signEd25519Digest(_input: SignYubiKeyDigestInput): Promise<{ signatureHex: string }> { throw new Error('not used'); }
}

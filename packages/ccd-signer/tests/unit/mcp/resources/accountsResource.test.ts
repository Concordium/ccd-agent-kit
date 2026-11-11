import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findAccountLabelInMap,
  ed25519SignerKeyRef,
  loadAccountCredentials,
  loadAccountLabels,
  type NetworkConfig,
} from '@ccd-agent-kit/config-utils';
import { caip2FromGenesis, caip2Reference, ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { listVisibleSignerInventoryKeys } from '../../../../src/core/modules/keyVisibility.js';
import {
  aggregateAccountSigningStatus,
  aggregateSignerBackendStatus,
  getSignerBackendStatus,
} from '../../../../src/core/modules/status.js';
import {
  formatAccountsResource,
} from '../../../../src/mcp/resources/accountsResource.js';

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  findAccountLabelInMap: vi.fn(),
  loadAccountCredentials: vi.fn(),
  loadAccountLabels: vi.fn(),
}));
vi.mock('../../../../src/core/modules/keyVisibility.js', () => ({ listVisibleSignerInventoryKeys: vi.fn() }));
vi.mock('../../../../src/core/modules/status.js', () => ({
  aggregateAccountSigningStatus: vi.fn(),
  aggregateSignerBackendStatus: vi.fn(),
  getSignerBackendStatus: vi.fn(),
}));

const publicKey = ed25519PublicKey.require('11'.repeat(32));
const secondKey = ed25519PublicKey.require('22'.repeat(32));
const accountAddress = '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP';
const remoteAccountAddress = '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus';
const genesisHash = '33'.repeat(32);
const networkConfig = {
  caip2: caip2FromGenesis(genesisHash), genesisHash, grpc: { host: 'node', port: 20000, ssl: true },
} satisfies NetworkConfig;
const backend = { backend: { ref: 'one' }, createdAt: '2026-01-01', signingModule: 'test', updatedAt: '2026-01-01' };

describe('accountsResource', () => {
  beforeEach(() => {
    vi.mocked(loadAccountLabels).mockReset().mockReturnValue({ alice: accountAddress });
    vi.mocked(findAccountLabelInMap).mockReset().mockReturnValue('alice');
    vi.mocked(loadAccountCredentials).mockReset().mockReturnValue({
      [accountAddress]: {
        accountThreshold: '1',
        credentials: {
          0: { keys: { 0: { publicKey, scheme: 'Ed25519' } }, threshold: '1' },
          1: { keys: { 0: { publicKey, scheme: 'Ed25519' }, 1: { publicKey: secondKey, scheme: 'Ed25519' } }, threshold: '1' },
        },
        sourceBlock: { hash: '44'.repeat(32), height: '1', time: '2026-01-01T00:00:00.000Z' },
      },
    });
    vi.mocked(listVisibleSignerInventoryKeys).mockReset().mockReturnValue([
      {
        keyRef: ed25519SignerKeyRef(publicKey),
        publicKey,
        entry: { scheme: 'Ed25519', backends: [backend], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        backends: [backend],
      },
      {
        keyRef: ed25519SignerKeyRef(secondKey),
        publicKey: secondKey,
        entry: { scheme: 'Ed25519', backends: [backend], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        backends: [backend],
      },
    ]);
    vi.mocked(getSignerBackendStatus).mockReset().mockReturnValue('unlocked');
    vi.mocked(aggregateSignerBackendStatus).mockReset().mockReturnValue('unlocked');
    vi.mocked(aggregateAccountSigningStatus).mockReset().mockReturnValue('available');
  });

  it('captures the default network and projects signer-visible observed keys with deduplication', () => {
    const result = formatAccountsResource({ caip2: networkConfig.caip2 });

    expect(loadAccountCredentials).toHaveBeenCalledWith(caip2Reference(networkConfig.caip2));
    expect(result).toEqual({
      accounts: [{
        address: accountAddress, label: 'alice', signingStatus: 'available',
        publicKeys: [publicKey, secondKey],
        keys: [
          { publicKey, scheme: 'Ed25519', status: 'unlocked' },
          { publicKey: secondKey, scheme: 'Ed25519', status: 'unlocked' },
        ],
      }],
    });
    expect(aggregateAccountSigningStatus).toHaveBeenCalledWith(['unlocked', 'unlocked']);
  });

  it('uses an explicit network identifier and omits observations without local keys', () => {
    vi.mocked(loadAccountCredentials).mockReturnValue({
      [remoteAccountAddress]: {
        accountThreshold: '1',
        credentials: { 0: { keys: { 0: { publicKey: ed25519PublicKey.require('55'.repeat(32)), scheme: 'Ed25519' } } } },
        sourceBlock: { hash: '66'.repeat(32), height: '2', time: '2026-01-01T00:00:00.000Z' },
      },
    });

    expect(formatAccountsResource({ caip2: networkConfig.caip2 })).toEqual({ accounts: [] });
  });
});

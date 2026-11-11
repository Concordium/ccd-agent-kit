import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeCatalogLabel, type StoredCatalogLabel } from '@ccd-agent-kit/config-utils';

import type { VisibleSignerInventoryKey } from '../../../../src/core/modules/keyVisibility.js';

const producer = vi.hoisted(() => ({ keys: [] as VisibleSignerInventoryKey[] }));
vi.mock('../../../../src/core/modules/keyVisibility.js', () => ({
  listVisibleSignerInventoryKeys: () => producer.keys,
}));

import { listSignerKeys } from '../../../../src/core/keys/listSignerKeys.js';
import { registerSignerModule } from '../../../../src/core/modules/registry.js';
import { testEd25519PublicKey } from '../../../helpers/ed25519.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  producer.keys = [];
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('listSignerKeys', () => {
  it('projects only safe public metadata, sorts keys, and aggregates visible backend status', () => {
    cleanups.push(registerSignerModule({
      defaultEnabled: true,
      getBackendStatus: ({ backend }) => (backend as { status: 'locked' | 'unlocked' }).status,
      id: 'list-test',
      isBackendVisible: () => true,
      signEd25519Digest: async () => '',
    }));
    producer.keys = [visibleKey('ff', 'locked', encodeCatalogLabel('agent', 'soft')), visibleKey('11', 'unlocked')];

    const result = listSignerKeys();

    expect(result).toEqual({ keys: [
      { publicKey: testEd25519PublicKey('11'), scheme: 'Ed25519', status: 'unlocked' },
      { label: 'agent', publicKey: testEd25519PublicKey('ff'), scheme: 'Ed25519', status: 'locked' },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/backend|secret-ref/);
  });
});

function visibleKey(byte: string, status: 'locked' | 'unlocked', label?: StoredCatalogLabel): VisibleSignerInventoryKey {
  const publicKey = testEd25519PublicKey(byte);
  return {
    backends: [{ backend: { ref: 'secret-ref', status }, createdAt: '', signingModule: 'list-test', updatedAt: '' }],
    entry: { backends: [], createdAt: '', ...(label === undefined ? {} : { label }), scheme: 'Ed25519', updatedAt: '' },
    keyRef: `ed25519:${publicKey}`,
    publicKey,
  };
}

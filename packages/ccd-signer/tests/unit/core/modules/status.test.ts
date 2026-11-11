import { afterEach, describe, expect, it } from 'vitest';

import { aggregateAccountSigningStatus, aggregateSignerBackendStatus, getSignerBackendStatus } from '../../../../src/core/modules/status.js';
import { registerSignerModule } from '../../../../src/core/modules/registry.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

describe('signer backend status', () => {
  it('uses module status and conservatively defaults unknown modules', () => {
    cleanups.push(registerSignerModule({
      defaultEnabled: true,
      getBackendStatus: () => 'locked',
      id: 'status-test',
      isBackendVisible: () => true,
      signEd25519Digest: async () => '',
    }));
    const entry = (signingModule: string) => ({ backend: {}, createdAt: '', signingModule, updatedAt: '' });

    expect(getSignerBackendStatus(entry('status-test'), 'Ed25519')).toBe('locked');
    expect(getSignerBackendStatus(entry('missing'), 'Ed25519')).toBe('unknown');
  });

  it('aggregates availability in attempt priority order', () => {
    expect(aggregateSignerBackendStatus(['unavailable', 'unknown', 'locked', 'unlocked'])).toBe('unlocked');
    expect(aggregateSignerBackendStatus(['unavailable', 'unknown', 'locked'])).toBe('locked');
    expect(aggregateSignerBackendStatus(['unavailable', 'unknown'])).toBe('unknown');
    expect(aggregateSignerBackendStatus([])).toBe('unavailable');
    expect(aggregateAccountSigningStatus(['unlocked'])).toBe('available');
  });
});

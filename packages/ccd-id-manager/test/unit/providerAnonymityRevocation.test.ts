import { describe,expect,it } from 'vitest';
import { resolveAnonymityRevocationPolicy } from '../../src/core/providers/anonymityRevocation.js';

const ar = (arIdentity: number) => ({ arIdentity }) as never;

describe('anonymity-revocation policy authoritative-map guards', () => {
  it.each([
    ['empty map', {}],
    ['invalid AR identity', { '0': ar(0) }],
    ['duplicate AR identities', { '1': ar(1), '2': ar(1) }],
  ])('rejects an %s', (_case, available) => {
    expect(() => resolveAnonymityRevocationPolicy({ anonymityRevokerThreshold: 1 }, available))
      .toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });

  it('rejects an authoritative map whose key does not match its AR identity', () => {
    expect(() => resolveAnonymityRevocationPolicy(
      { anonymityRevokers: [1], anonymityRevokerThreshold: 1 },
      { '1': ar(2) },
    )).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });
});

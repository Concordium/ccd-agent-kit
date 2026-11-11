import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getIdentityContextSnapshot,
  getIdentityContextSnapshotPathForNetwork,
  setIdentityContextSnapshot,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const GENESIS = '12'.repeat(32);
const REF = GENESIS.slice(0, 32);
const OTHER_REF = '34'.repeat(16);

function snapshot() {
  return {
    version: 1 as const,
    network: { caip2: `ccd:${REF}`, genesisHash: GENESIS },
    sourceBlock: { hash: 'ab'.repeat(32), height: '123', time: '2026-10-16T11:59:59.000Z' },
    observedAt: '2026-10-16T12:00:00.000Z',
    globalContext: {
      onChainCommitmentKey: '66'.repeat(48),
      bulletproofGenerators: '77'.repeat(64),
      genesisString: 'local-testnet-genesis',
    },
    identityProviders: [
      {
        ipIdentity: 0,
        ipDescription: { name: 'Zero ID', url: 'https://zero.example.test', description: 'Provider zero' },
        ipVerifyKey: '22'.repeat(32),
        ipCdiVerifyKey: '33'.repeat(96),
      },
    ],
    anonymityRevokers: [
      {
        arIdentity: 1,
        arDescription: { name: 'AR one', url: 'https://ar1.example.test', description: '' },
        arPublicKey: '44'.repeat(96),
      },
    ],
  };
}

describe('identity context snapshot cache', () => {
  useConfigSandbox();

  it('uses the state root and a validated 32-hex network reference', () => {
    expect(getIdentityContextSnapshotPathForNetwork(REF)).toBe(
      join(process.env.XDG_STATE_HOME!, 'ccd-agent-kit', 'identity-context', `${REF}.json`),
    );
    expect(() => getIdentityContextSnapshotPathForNetwork(`ccd:${REF}`)).toThrow();
    expect(() => getIdentityContextSnapshotPathForNetwork('../outside')).toThrow();
  });

  it('writes pretty JSON and reads a detached validated snapshot', () => {
    const input = snapshot();
    setIdentityContextSnapshot(REF, input);

    const path = getIdentityContextSnapshotPathForNetwork(REF);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(input, null, 2)}\n`);

    const loaded = getIdentityContextSnapshot(REF);
    expect(loaded).toEqual(input);
    expect(loaded).not.toBe(input);
    input.globalContext.genesisString = 'mutated';
    expect(loaded?.globalContext.genesisString).toBe('local-testnet-genesis');
  });

  it('returns undefined for a missing cache without creating state', () => {
    const path = getIdentityContextSnapshotPathForNetwork(REF);
    expect(getIdentityContextSnapshot(REF)).toBeUndefined();
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it.each([
    ['malformed JSON', '{'],
    ['an invalid snapshot', JSON.stringify({ ...snapshot(), version: 2 })],
    [
      'a snapshot for another network',
      JSON.stringify({ ...snapshot(), network: { caip2: `ccd:${OTHER_REF}`, genesisHash: '34'.repeat(32) } }),
    ],
  ])('returns undefined for %s and leaves the cache unchanged', (_label, contents) => {
    const path = getIdentityContextSnapshotPathForNetwork(REF);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');

    expect(getIdentityContextSnapshot(REF)).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(contents);
  });

  it('returns undefined when the cache cannot be read', () => {
    mkdirSync(getIdentityContextSnapshotPathForNetwork(REF), { recursive: true });
    expect(getIdentityContextSnapshot(REF)).toBeUndefined();
  });

  it('enforces network isolation before writing and preserves the existing cache on mismatch', () => {
    setIdentityContextSnapshot(REF, snapshot());
    const path = getIdentityContextSnapshotPathForNetwork(REF);
    const before = readFileSync(path, 'utf8');

    expect(() => setIdentityContextSnapshot(OTHER_REF, snapshot())).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('propagates write failures', () => {
    const path = getIdentityContextSnapshotPathForNetwork(REF);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'sentinel'), 'preserve', 'utf8');

    expect(() => setIdentityContextSnapshot(REF, snapshot())).toThrow();
    expect(readFileSync(join(path, 'sentinel'), 'utf8')).toBe('preserve');
  });
});

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAccountCredentialObservation,
  getAccountCredentialsPathForNetwork,
  loadAccountCredentials,
  removeAccountCredentialObservation,
  saveAccountCredentials,
  setAccountCredentialObservation,
  setAccountCredentialRefreshError,
  type AccountCredentialObservation,
} from '../../src/index.js';
import { makeTestTempDir } from '../helpers/tempDir.js';

const originalEnv = { ...process.env };
const CAIP2_REF = '4221332d34e1694168c2a0c0b3fd0f27';
const ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const ALIAS_CANONICAL = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const ALIAS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vmvFkzzQhiY';

const observation: AccountCredentialObservation = {
  accountThreshold: '1',
  credentials: {
    '0': {
      keys: {
        '0': { publicKey: ed25519PublicKey.require('ab'.repeat(32)), scheme: 'Ed25519' },
      },
      threshold: '1',
    },
  },
  sourceBlock: {
    hash: 'cd'.repeat(32),
    height: '123',
    time: '2026-09-24T00:00:00.000Z',
  },
};

describe('account credentials', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTestTempDir('ccd-account-credentials-');
    process.env = { ...originalEnv, XDG_STATE_HOME: tempDir };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads an empty map for missing or malformed files', () => {
    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});

    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(getAccountCredentialsPathForNetwork(CAIP2_REF), '[]', 'utf8');

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });

  it.each(['', 'not-an-account-address'])('rejects cached observations with invalid account key %j', (address) => {
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({ [address]: observation })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });

  it.each(['NaN', '1.5', '-1', '256', '00', '01', '+1', '1e2'])('rejects cached credential index %j', (index) => {
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({ [ADDRESS]: { ...observation, credentials: { [index]: observation.credentials['0'] } } })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });

  it('loads credential index boundaries and account aliases', () => {
    const boundaryObservation = {
      ...observation,
      credentials: { '0': observation.credentials['0']!, '255': observation.credentials['0']! },
    };
    saveAccountCredentials({ [ALIAS]: boundaryObservation }, CAIP2_REF);

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({ [ALIAS]: boundaryObservation });
  });

  it('ignores cached observations with malformed credential IDs', () => {
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({ [ADDRESS]: { ...observation, credentials: { '0': { ...observation.credentials['0']!, credentialId: 'not-hex' } } } })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });

  it('ignores cached observations with malformed public keys', () => {
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({
        [ADDRESS]: {
          ...observation,
          credentials: { '0': { keys: { '0': { publicKey: 'ab'.repeat(31), scheme: 'Ed25519' } }, threshold: '1' } },
        },
      })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });

  it('canonicalizes cached public key hex', () => {
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({
        [ADDRESS]: {
          ...observation,
          credentials: { '0': { keys: { '0': { publicKey: 'AB'.repeat(32), scheme: 'Ed25519' } }, threshold: '1' } },
        },
      })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)[ADDRESS]?.credentials['0']?.keys['0']?.publicKey).toBe('ab'.repeat(32));
  });

  it('ignores cached observations without an account threshold', () => {
    const legacyObservation: Partial<AccountCredentialObservation> = { ...observation };
    delete legacyObservation.accountThreshold;
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({ [ADDRESS]: legacyObservation })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });

  it('saves finalized observations keyed by canonical address and replaces aliases', () => {
    saveAccountCredentials({ [ADDRESS]: observation }, CAIP2_REF);

    expect(loadAccountCredentials(CAIP2_REF)).toEqual({ [ADDRESS]: observation });
    expect(getAccountCredentialObservation(ADDRESS, CAIP2_REF)).toEqual(observation);
    expect(getAccountCredentialObservation('unknown', CAIP2_REF)).toBeUndefined();

    saveAccountCredentials({ [ALIAS]: observation }, CAIP2_REF);
    setAccountCredentialObservation(ALIAS_CANONICAL, observation, CAIP2_REF);
    expect(loadAccountCredentials(CAIP2_REF)).toEqual({ [ALIAS_CANONICAL]: observation });
  });

  it.each([
    { key: '', value: observation },
    { key: 'not-an-account-address', value: observation },
    { key: ADDRESS, value: { ...observation, credentials: { NaN: observation.credentials['0']! } } },
    { key: ADDRESS, value: { ...observation, credentials: { '1.5': observation.credentials['0']! } } },
    { key: ADDRESS, value: { ...observation, credentials: { '-1': observation.credentials['0']! } } },
    { key: ADDRESS, value: { ...observation, credentials: { '256': observation.credentials['0']! } } },
    { key: ADDRESS, value: { ...observation, credentials: { '01': observation.credentials['0']! } } },
  ])('rejects invalid writes without changing existing bytes: $key', ({ key, value }) => {
    saveAccountCredentials({ [ADDRESS]: observation }, CAIP2_REF);
    const path = getAccountCredentialsPathForNetwork(CAIP2_REF);
    const before = readFileSync(path);

    expect(() => saveAccountCredentials({ [key]: value }, CAIP2_REF)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it('normalizes cached credential key schemes without regard to casing', () => {
    mkdirSync(dirname(getAccountCredentialsPathForNetwork(CAIP2_REF)), { recursive: true });
    writeFileSync(
      getAccountCredentialsPathForNetwork(CAIP2_REF),
      `${JSON.stringify({ [ADDRESS]: { ...observation, credentials: { '0': { keys: { '0': { publicKey: 'ab'.repeat(32), scheme: 'ed25519' } }, threshold: '1' } } } })}\n`,
      'utf8',
    );

    expect(loadAccountCredentials(CAIP2_REF)[ADDRESS]?.credentials['0']?.keys['0']?.scheme).toBe('Ed25519');
  });

  it('records refresh errors only for existing observations and clears them on success', () => {
    expect(
      setAccountCredentialRefreshError(
        ADDRESS,
        { attempted: '2026-09-25T00:00:00.000Z', kind: 'node', message: 'unavailable' },
        CAIP2_REF,
      ),
    ).toBe(false);

    saveAccountCredentials({ [ALIAS]: observation }, CAIP2_REF);
    expect(
      setAccountCredentialRefreshError(
        ALIAS_CANONICAL,
        { attempted: '2026-09-25T00:00:00.000Z', kind: 'node', message: 'unavailable' },
        CAIP2_REF,
      ),
    ).toBe(true);
    expect(loadAccountCredentials(CAIP2_REF)[ALIAS]?.refreshError).toMatchObject({ kind: 'node' });

    setAccountCredentialObservation(ALIAS_CANONICAL, observation, CAIP2_REF);
    expect(loadAccountCredentials(CAIP2_REF)[ALIAS_CANONICAL]?.refreshError).toBeUndefined();
  });

  it('removes observations by canonical address', () => {
    setAccountCredentialObservation(ADDRESS, observation, CAIP2_REF);

    expect(removeAccountCredentialObservation(ADDRESS, CAIP2_REF)).toBe(true);
    expect(removeAccountCredentialObservation(ADDRESS, CAIP2_REF)).toBe(false);
    expect(loadAccountCredentials(CAIP2_REF)).toEqual({});
  });
});

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CatalogLabelError,
  getAccountLabelsPath,
  getAccountLabelsPathForNetwork,
  loadAccountLabels,
  findAccountLabelForAddress,
  listAccountLabelAddresses,
  resolveAccountLabel,
  saveAccountLabels,
  setAccountLabel,
  setSoftAccountLabel,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const ALIAS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vmvFkzzQhiY';
const OTHER_ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const NETWORK = '4221332d34e1694168c2a0c0b3fd0f23';

describe('protected public catalog labels', () => {
  useConfigSandbox();

  it('finds a hard alias before a soft exact-address entry and preserves both catalog files on failure', () => {
    const filename = getAccountLabelsPathForNetwork(NETWORK);
    saveAccountLabels({ '@agent': ADDRESS, operator: ALIAS }, NETWORK);
    const original = readFileSync(filename, 'utf8');
    const index = readFileSync(getAccountLabelsPath(), 'utf8');

    let failure: unknown;
    try {
      setSoftAccountLabel('replacement', ADDRESS, NETWORK);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CatalogLabelError);
    expect(failure).toMatchObject({ code: 'LABEL_PROTECTED' });
    expect(readFileSync(filename, 'utf8')).toBe(original);
    expect(readFileSync(getAccountLabelsPath(), 'utf8')).toBe(index);
    expect(loadAccountLabels(NETWORK)).toEqual({ '@agent': ADDRESS, operator: ALIAS });
  });

  it('persists and projects the prepared soft account label with canonical casing', () => {
    setAccountLabel({ address: OTHER_ADDRESS, label: 'OperatorCase', mode: 'hard' }, NETWORK);
    setSoftAccountLabel('AgentCase', ADDRESS, NETWORK);

    expect(loadAccountLabels(NETWORK)).toEqual({ '@AgentCase': ADDRESS, OperatorCase: OTHER_ADDRESS });
    expect(resolveAccountLabel('agentcase', NETWORK)?.address).toBe(ADDRESS);
    expect(findAccountLabelForAddress(ADDRESS, NETWORK)).toBe('AgentCase');
  });

  it('removes only the selected soft account label', () => {
    saveAccountLabels({ '@AgentCase': ADDRESS, OperatorCase: OTHER_ADDRESS }, NETWORK);

    setSoftAccountLabel(undefined, ADDRESS, NETWORK);

    expect(loadAccountLabels(NETWORK)).toEqual({ OperatorCase: OTHER_ADDRESS });
  });

  it('reports an account-specific duplicate-label failure without changing either catalog file', () => {
    saveAccountLabels({ Existing: ADDRESS, Other: OTHER_ADDRESS }, NETWORK);
    const authoritative = readFileSync(getAccountLabelsPathForNetwork(NETWORK), 'utf8');
    const index = readFileSync(getAccountLabelsPath(), 'utf8');

    let failure: unknown;
    try {
      setAccountLabel({ address: OTHER_ADDRESS, label: 'existing', mode: 'hard' }, NETWORK);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'DUPLICATE_LABEL', message: expect.stringMatching(/already used/i) });
    expect(readFileSync(getAccountLabelsPathForNetwork(NETWORK), 'utf8')).toBe(authoritative);
    expect(readFileSync(getAccountLabelsPath(), 'utf8')).toBe(index);
  });

  it('preserves alias-equivalent hard-label no-ops and both catalog files byte-for-byte', () => {
    saveAccountLabels({ OperatorCase: ALIAS, '@agent': ADDRESS }, NETWORK);
    const authoritativePath = getAccountLabelsPathForNetwork(NETWORK);
    const indexPath = getAccountLabelsPath();
    const authoritative = readFileSync(authoritativePath, 'utf8');
    const index = readFileSync(indexPath, 'utf8');

    setSoftAccountLabel('OperatorCase', ADDRESS, NETWORK);

    expect(readFileSync(authoritativePath, 'utf8')).toBe(authoritative);
    expect(readFileSync(indexPath, 'utf8')).toBe(index);
    expect(loadAccountLabels(NETWORK)).toEqual({ OperatorCase: ALIAS, '@agent': ADDRESS });
  });

  it('lists account addresses and sanitizes malformed persisted label failures', () => {
    setAccountLabel({ address: ADDRESS, label: 'operator', mode: 'hard' }, NETWORK);
    expect(listAccountLabelAddresses(NETWORK)).toEqual([ADDRESS]);
    const filename = getAccountLabelsPathForNetwork(NETWORK);
    writeFileSync(filename, `${JSON.stringify({ '@@invalid': ADDRESS })}\n`, { mode: 0o600 });
    expect(() => findAccountLabelForAddress(ADDRESS, NETWORK)).toThrow(/invalid account label/i);
  });

});

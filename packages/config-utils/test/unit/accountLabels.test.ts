import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findAccountLabelForAddress, findAccountLabelInMap, findAccountLabelScopes, findAddressLabelScopes, getAccountLabelsPath, getAccountLabelsPathForNetwork,
  getDataDir, getStateDir, loadAccountLabels, loadAccountLabelsIndex, removeAccountLabel, resolveAccountLabel, saveAccountLabels, setAccountLabel,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';
import { readJsonFile, writeJsonFile } from '../helpers/jsonFile.js';

const MAINNET = '9dd9ca4d19e9393877d2c44b70f89acb';
const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const ALIAS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vmvFkzzQhiY';

describe('account-label rules', () => {
  useConfigSandbox();

  it('preserves untouched index entries and metadata during synchronization', () => {
    const stored = {
      version: 1, metadata: 'retained',
      networks: {
        ['__proto__']: { labels: { legacy: '4Legacy' }, metadata: 'network metadata' },
        other: { labels: { alice: ADDRESS }, metadata: 'retained network metadata' },
      },
    };
    writeJsonFile(getAccountLabelsPath(), stored);
    expect(loadAccountLabelsIndex()).toEqual(stored);
    setAccountLabel({ address: ADDRESS, label: 'alice', mode: 'hard' }, MAINNET);
    expect(readJsonFile(getAccountLabelsPath())).toEqual({
      ...stored, networks: { ...stored.networks, [MAINNET]: { labels: { alice: ADDRESS } } },
    });
  });

  it('uses the account-label storage paths and labels index field', () => {
    expect(getAccountLabelsPathForNetwork(MAINNET)).toBe(join(getDataDir(), 'account-labels', `${MAINNET}.json`));
    expect(getAccountLabelsPath()).toBe(join(getStateDir(), 'account-labels.json'));
    expect(loadAccountLabels(MAINNET)).toEqual({});
    expect(loadAccountLabelsIndex()).toEqual({ version: 1, networks: {} });

    saveAccountLabels({ operator: ADDRESS }, MAINNET);
    expect(readJsonFile(getAccountLabelsPathForNetwork(MAINNET))).toEqual({ operator: ADDRESS });
    expect(readJsonFile(getAccountLabelsPath())).toEqual({
      version: 1, networks: { [MAINNET]: { labels: { operator: ADDRESS } } },
    });
  });

  it('rejects a numeric account label that would be ambiguous with an account index', () => {
    expect(() => setAccountLabel({ address: ADDRESS, label: '42', mode: 'hard' }, MAINNET)).toThrow();
  });

  it('validates labels before writing either file', () => {
    saveAccountLabels({ alice: ADDRESS }, MAINNET);
    const index = loadAccountLabelsIndex();
    expect(() => saveAccountLabels({ 'bad label': ADDRESS }, MAINNET)).toThrow(/contain only letters/);
    expect(readJsonFile(getAccountLabelsPathForNetwork(MAINNET))).toEqual({ alice: ADDRESS });
    expect(loadAccountLabelsIndex()).toEqual(index);
  });

  it('rejects invalid stored label catalogs before a mutation can replace them', () => {
    saveAccountLabels({ Existing: ADDRESS }, MAINNET);
    const index = readJsonFile(getAccountLabelsPath());
    const invalid = { 'bad label': ADDRESS };
    writeJsonFile(getAccountLabelsPathForNetwork(MAINNET), invalid);
    expect(() => loadAccountLabels(MAINNET)).toThrow();
    expect(() => setAccountLabel({ address: ADDRESS, label: 'Replacement', mode: 'hard' }, MAINNET)).toThrow();
    expect(readJsonFile(getAccountLabelsPathForNetwork(MAINNET))).toEqual(invalid);
    expect(readJsonFile(getAccountLabelsPath())).toEqual(index);
  });

  it('rejects malformed index structures without replacing authoritative maps', () => {
    saveAccountLabels({ alice: ADDRESS }, MAINNET);
    for (const invalid of [null, [], { version: 2, networks: {} }, { version: 1, networks: null },
      { version: 1, networks: { bad: null } }, { version: 1, networks: { bad: { labels: { alice: 42 } } } }]) {
      writeJsonFile(getAccountLabelsPath(), invalid);
      expect(loadAccountLabelsIndex()).toEqual({ version: 1, networks: {} });
      expect(loadAccountLabels(MAINNET)).toEqual({ alice: ADDRESS });
    }
  });

  it('propagates network-file write failures without updating the index', () => {
    setAccountLabel({ address: ADDRESS, label: 'alice', mode: 'hard' }, MAINNET);
    const index = loadAccountLabelsIndex();
    mkdirSync(getAccountLabelsPathForNetwork('blocked'), { recursive: true });
    expect(() => saveAccountLabels({ bob: ALIAS }, 'blocked')).toThrow();
    expect(loadAccountLabelsIndex()).toEqual(index);
  });

  it('reports index write failures after persisting the authoritative file', () => {
    mkdirSync(getAccountLabelsPath(), { recursive: true });
    expect(() => saveAccountLabels({ alice: ADDRESS }, MAINNET)).toThrow();
    expect(loadAccountLabels(MAINNET)).toEqual({ alice: ADDRESS });
  });

  it('prefers an exact match over an earlier alias, falling back to the stored alias', () => {
    const labels = { alias: ALIAS, exact: ADDRESS };
    saveAccountLabels(labels, MAINNET);
    expect(findAccountLabelForAddress(ADDRESS, MAINNET)).toBe('exact');
    expect(findAccountLabelInMap(ADDRESS, labels)).toBe('exact');
    expect(findAccountLabelInMap(ADDRESS, loadAccountLabels(MAINNET))).toBe('exact');
    expect(findAccountLabelInMap('unknown', labels)).toBeUndefined();
    saveAccountLabels({ alias: ALIAS }, MAINNET);
    expect(findAccountLabelForAddress(ADDRESS, MAINNET)).toBe('alias');
    expect(findAccountLabelInMap(ADDRESS, loadAccountLabels(MAINNET))).toBe('alias');
    expect(findAccountLabelScopes('alias')).toEqual([{
      scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label: 'alias', address: ALIAS,
    }]);
    expect(findAddressLabelScopes(ADDRESS)).toEqual([{
      scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label: 'alias', address: ALIAS,
    }]);
  });

  it('normalizes bare lookup and removal selectors while ignoring account addresses', () => {
    saveAccountLabels({ '@alice': ADDRESS }, MAINNET);
    expect(resolveAccountLabel(' alice ', MAINNET)?.address).toBe(ADDRESS);
    expect(findAccountLabelScopes(' alice ')).toEqual([{
      scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label: 'alice', address: ADDRESS,
    }]);
    expect(resolveAccountLabel(ADDRESS, MAINNET)).toBeUndefined();
    expect(findAccountLabelScopes('@alice')).toEqual([]);
    expect(removeAccountLabel('@alice', MAINNET)).toBe(false);
    expect(loadAccountLabels(MAINNET)).toEqual({ '@alice': ADDRESS });
    expect(removeAccountLabel(' alice ', MAINNET)).toBe(true);
    expect(loadAccountLabels(MAINNET)).toEqual({});
  });

  it('returns the canonical selected label and its own stored address from one account-map match', () => {
    saveAccountLabels({ First: ADDRESS, Selected: ADDRESS, AliasSelected: ALIAS }, MAINNET);

    expect(resolveAccountLabel(' selected ', MAINNET)).toEqual({ address: ADDRESS, label: 'Selected' });
    expect(resolveAccountLabel('aliasselected', MAINNET)).toEqual({ address: ALIAS, label: 'AliasSelected' });
    expect(resolveAccountLabel('SELECTED', MAINNET)?.address).toBe(ADDRESS);
    expect(resolveAccountLabel('Missing', MAINNET)).toBeUndefined();
    expect(resolveAccountLabel(ADDRESS, MAINNET)).toBeUndefined();
    expect(resolveAccountLabel('@Selected', MAINNET)).toBeUndefined();
  });
});

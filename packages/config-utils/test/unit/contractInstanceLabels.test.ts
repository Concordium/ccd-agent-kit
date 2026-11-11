import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CatalogLabelError,
  findContractInstanceAddressLabelScopes,
  findContractInstanceLabelForAddress,
  findContractInstanceLabelScopes,
  getContractInstanceLabelsPath,
  getContractInstanceLabelsPathForNetwork,
  loadContractInstanceLabels,
  loadContractInstanceLabelsIndex,
  rebuildContractInstanceLabelsIndex,
  resolveContractInstanceLabel,
  saveContractInstanceLabels,
  saveContractInstanceLabelsIndex,
  setDefaultNetwork,
  setContractInstanceLabel,
  setSoftContractInstanceLabel,
  type ContractInstanceLabelMap,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';
import { readJsonFile, writeJsonFile } from '../helpers/jsonFile.js';

const MAINNET = '9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET = '4221332d34e1694168c2a0c0b3fd0f27';
const FIRST = { index: '12', subindex: '0' } as const;
const SECOND = { index: '13', subindex: '1' } as const;

describe('contract-instance labels', () => {
  useConfigSandbox();

  it('stores hard and soft labels in authoritative maps and a labels-based version-1 index', () => {
    const labels: ContractInstanceLabelMap = { operator: FIRST, '@agent': SECOND };
    saveContractInstanceLabels(labels, MAINNET);

    expect(readJsonFile(getContractInstanceLabelsPathForNetwork(MAINNET))).toEqual(labels);
    expect(loadContractInstanceLabels(MAINNET)).toEqual(labels);
    expect(loadContractInstanceLabelsIndex()).toEqual({
      version: 1,
      networks: { [MAINNET]: { labels } },
    });
    expect(readJsonFile(getContractInstanceLabelsPath())).toEqual({
      version: 1,
      networks: { [MAINNET]: { labels } },
    });
  });

  it('persists and projects a prepared label with canonical address and casing while keeping networks isolated', () => {
    saveContractInstanceLabels({ existing: SECOND }, MAINNET);
    setContractInstanceLabel({ address: { index: '0012', subindex: '00' }, label: ' TokenCase ', mode: 'soft' }, MAINNET);
    setContractInstanceLabel({ address: FIRST, label: 'operator', mode: 'hard' }, TESTNET);

    expect(loadContractInstanceLabels(MAINNET)).toEqual({ existing: SECOND, '@TokenCase': FIRST });
    expect(loadContractInstanceLabels(TESTNET)).toEqual({ operator: FIRST });
    expect(resolveContractInstanceLabel(' tokencase ', MAINNET)).toEqual(FIRST);
    expect(findContractInstanceLabelForAddress(FIRST, MAINNET)).toBe('TokenCase');
    expect(findContractInstanceLabelForAddress(FIRST, TESTNET)).toBe('operator');
  });

  it('uses the active default network when setters omit the network', () => {
    setDefaultNetwork('testnet');
    setContractInstanceLabel({ address: FIRST, label: 'operator', mode: 'soft' });
    setSoftContractInstanceLabel('agent', SECOND);

    expect(loadContractInstanceLabels(TESTNET)).toEqual({ '@operator': FIRST, '@agent': SECOND });
    expect(loadContractInstanceLabels(MAINNET)).toEqual({});
  });

  it('normalizes valid selectors and returns undefined or no matches for invalid selectors', () => {
    saveContractInstanceLabels({ '@token': FIRST }, MAINNET);
    expect(resolveContractInstanceLabel(' token ', MAINNET)).toEqual(FIRST);
    expect(resolveContractInstanceLabel('@token', MAINNET)).toBeUndefined();
    expect(resolveContractInstanceLabel('bad label', MAINNET)).toBeUndefined();
    expect(findContractInstanceLabelScopes(' token ')).toEqual([{
      scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label: 'token', address: FIRST,
    }]);
    expect(findContractInstanceLabelScopes('@token')).toEqual([]);
    expect(findContractInstanceAddressLabelScopes(FIRST)).toEqual([{
      scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label: 'token', address: FIRST,
    }]);
  });

  it('protects a hard contract label without changing authoritative or indexed state', () => {
    saveContractInstanceLabels({ operator: FIRST }, MAINNET);
    const authoritative = readFileSync(getContractInstanceLabelsPathForNetwork(MAINNET), 'utf8');
    const index = readFileSync(getContractInstanceLabelsPath(), 'utf8');

    let failure: unknown;
    try {
      setSoftContractInstanceLabel('agent', FIRST, MAINNET);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CatalogLabelError);
    expect(failure).toMatchObject({ code: 'LABEL_PROTECTED' });
    expect(readFileSync(getContractInstanceLabelsPathForNetwork(MAINNET), 'utf8')).toBe(authoritative);
    expect(readFileSync(getContractInstanceLabelsPath(), 'utf8')).toBe(index);
    expect(loadContractInstanceLabels(MAINNET)).toEqual({ operator: FIRST });
  });

  it.each(['constructor', 'toString', 'hasOwnProperty'])('treats %s as a label, not an inherited object property', (label) => {
    expect(resolveContractInstanceLabel(label, MAINNET)).toBeUndefined();
    expect(findContractInstanceLabelScopes(label)).toEqual([]);
    setContractInstanceLabel({ address: FIRST, label, mode: 'hard' }, MAINNET);
    expect(resolveContractInstanceLabel(label, MAINNET)).toEqual(FIRST);
    expect(findContractInstanceLabelScopes(label)).toEqual([{
      scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label, address: FIRST,
    }]);
    expect(() => setSoftContractInstanceLabel(undefined, FIRST, MAINNET)).toThrow(CatalogLabelError);
  });

  it('allows soft labels to be created, replaced, and removed by address', () => {
    setSoftContractInstanceLabel(' agent ', FIRST, MAINNET);
    expect(loadContractInstanceLabels(MAINNET)).toEqual({ '@agent': FIRST });
    setSoftContractInstanceLabel('replacement', FIRST, MAINNET);
    expect(loadContractInstanceLabels(MAINNET)).toEqual({ '@replacement': FIRST });
    setSoftContractInstanceLabel(undefined, FIRST, MAINNET);
    expect(loadContractInstanceLabels(MAINNET)).toEqual({});
  });

  it.each([
    [{ token: { index: '0012', subindex: '0' } }, 'noncanonical address'],
    [{ token: { index: '-1', subindex: '0' } }, 'invalid address'],
    [{ first: FIRST, second: FIRST }, 'duplicate target'],
  ] as const)('rejects bulk saves with %s (%s) before either file changes', (invalid, _reason) => {
    const original = { existing: SECOND };
    saveContractInstanceLabels(original, MAINNET);
    const index = readJsonFile(getContractInstanceLabelsPath());

    expect(() => saveContractInstanceLabels(invalid as ContractInstanceLabelMap, MAINNET)).toThrow();
    expect(readJsonFile(getContractInstanceLabelsPathForNetwork(MAINNET))).toEqual(original);
    expect(readJsonFile(getContractInstanceLabelsPath())).toEqual(index);
  });

  it.each([
    [[], 'non-object root'],
    [{ 'bad label': FIRST }, 'invalid stored label'],
    [{ first: FIRST, second: FIRST }, 'duplicate stored target'],
    [{ token: { index: 12, subindex: '0' } }, 'malformed stored address'],
    [{ token: { index: '12', subindex: 0 } }, 'malformed stored subindex'],
  ])('fails safely on an existing %s instead of treating it as empty (%s)', (invalid, _reason) => {
    const authoritativePath = getContractInstanceLabelsPathForNetwork(MAINNET);
    const existingIndex = { version: 1, networks: { [TESTNET]: { labels: { test: SECOND } } } };
    writeJsonFile(authoritativePath, invalid);
    writeJsonFile(getContractInstanceLabelsPath(), existingIndex);

    expect(() => setContractInstanceLabel({ address: SECOND, label: 'replacement', mode: 'hard' }, MAINNET)).toThrow();
    expect(readJsonFile(authoritativePath)).toEqual(invalid);
    expect(readJsonFile(getContractInstanceLabelsPath())).toEqual(existingIndex);
  });

  it('does not let a soft mutation overwrite an invalid existing authoritative map', () => {
    const authoritativePath = getContractInstanceLabelsPathForNetwork(MAINNET);
    const invalid = { token: FIRST, '@other': FIRST };
    writeJsonFile(authoritativePath, invalid);

    expect(() => setSoftContractInstanceLabel('agent', SECOND, MAINNET)).toThrow();
    expect(readJsonFile(authoritativePath)).toEqual(invalid);
  });

  it('fails safely and preserves malformed JSON during mutation', () => {
    const authoritativePath = getContractInstanceLabelsPathForNetwork(MAINNET);
    writeJsonFile(authoritativePath, {});
    writeFileSync(authoritativePath, '{');

    expect(() => setContractInstanceLabel({ address: FIRST, label: 'token', mode: 'hard' }, MAINNET)).toThrow();
    expect(readFileSync(authoritativePath, 'utf8')).toBe('{');
  });

  it('validates loaded index data under labels and preserves it after an invalid save', () => {
    writeJsonFile(getContractInstanceLabelsPath(), {
      version: 1,
      networks: { [MAINNET]: { labels: { token: FIRST } } },
    });
    expect(loadContractInstanceLabelsIndex()).toEqual({
      version: 1, networks: { [MAINNET]: { labels: { token: FIRST } } },
    });

    expect(() => saveContractInstanceLabelsIndex({
      version: 1, networks: { [MAINNET]: { labels: { token: { index: '0012', subindex: '0' } } } },
    })).toThrow();
    expect(readJsonFile(getContractInstanceLabelsPath())).toEqual({
      version: 1, networks: { [MAINNET]: { labels: { token: FIRST } } },
    });
  });

  it.each([
    null,
    { version: 2, networks: {} },
    { version: 1, networks: [] },
    { version: 1, networks: { [MAINNET]: null } },
    { version: 1, networks: { [MAINNET]: { labels: [] } } },
    { version: 1, networks: { [MAINNET]: { labels: { token: { index: '12', subindex: 0 } } } } },
  ])('falls back to an empty index for corrupted derived data %#', (invalid) => {
    writeJsonFile(getContractInstanceLabelsPath(), invalid);

    expect(loadContractInstanceLabelsIndex()).toEqual({ version: 1, networks: {} });
  });

  it('rejects a malformed derived index without overwriting the existing file', () => {
    const existing = { version: 1, networks: { [MAINNET]: { labels: { token: FIRST } } } };
    writeJsonFile(getContractInstanceLabelsPath(), existing);

    expect(() => saveContractInstanceLabelsIndex({
      version: 1,
      networks: { [MAINNET]: { labels: [] as unknown as ContractInstanceLabelMap } },
    })).toThrow();
    expect(readJsonFile(getContractInstanceLabelsPath())).toEqual(existing);
  });

  it('rebuilds the labels index from configured authoritative network files', () => {
    saveContractInstanceLabels({}, MAINNET);
    saveContractInstanceLabels({ test: SECOND }, TESTNET);
    writeJsonFile(getContractInstanceLabelsPath(), { version: 1, networks: { stale: { labels: { stale: FIRST } } } });

    expect(rebuildContractInstanceLabelsIndex()).toEqual({
      version: 1,
      networks: { [TESTNET]: { labels: { test: SECOND } } },
    });
  });

  it('returns no reverse match for an unlabeled address', () => {
    saveContractInstanceLabels({ token: FIRST }, MAINNET);

    expect(findContractInstanceLabelForAddress(SECOND, MAINNET)).toBeUndefined();
    expect(findContractInstanceAddressLabelScopes(SECOND)).toEqual([]);
  });

});

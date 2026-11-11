import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as config from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';
import { readJsonFile, writeJsonFile } from '../helpers/jsonFile.js';

const MAINNET = '9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET = '4221332d34e1694168c2a0c0b3fd0f27';
type Index<T> = { version: 1; networks: Record<string, { labels: Record<string, T> }> };
type Match<T> = { scope: 'network'; network?: string; caip2Ref?: string; label: string; address: T };
interface LabelStore<T> {
  path(ref: string): string;
  indexPath(): string;
  load(ref?: string): Record<string, T>;
  save(labels: Record<string, T>, ref?: string): void;
  loadIndex(): Index<T>;
  rebuild(): Index<T>;
  set(label: string, address: T, ref?: string): void;
  remove(label: string, ref?: string): boolean;
  resolve(label: string, ref?: string): T | undefined;
  find(address: T, ref?: string): string | undefined;
  labelScopes(label: string): Match<T>[];
  addressScopes(address: T): Match<T>[];
}

// Contract-instance labels have a separate policy suite in contractInstanceLabels.test.ts.
function accountLabelStoreTests<T>(label: string, store: LabelStore<T>, first: T, second: T) {
  describe(label, () => {
    useConfigSandbox();
    const labels = { primary: first };
    const index = (networks: Record<string, { labels: Record<string, T> }>): Index<T> => ({ version: 1, networks });

    it('defaults missing files and malformed indexes to empty without creating data', () => {
      expect(store.load()).toEqual({});
      expect(store.loadIndex()).toEqual(index({}));
      writeJsonFile(store.indexPath(), {});
      writeFileSync(store.indexPath(), '{');
      expect(store.loadIndex()).toEqual(index({}));
      expect(store.load()).toEqual({});
      expect(existsSync(store.path(MAINNET))).toBe(false);
    });

    it('saves and sets mappings in an explicit network and synchronizes its index', () => {
      store.save(labels, 'abcd');
      expect(store.load('abcd')).toEqual(labels);
      expect(store.loadIndex()).toEqual(index({ abcd: { labels } }));
      expect(store.resolve('primary', 'abcd')).toEqual(first);
      expect(store.find(first, 'abcd')).toBe('primary');
      store.set('secondary', second, 'abcd');
      expect(store.load('abcd')).toEqual({ ...labels, secondary: second });
      expect(store.resolve('secondary', 'abcd')).toEqual(second);
      expect(store.find(second, 'abcd')).toBe('secondary');
      expect(store.load()).toEqual({});
    });

    it('uses network files rather than stale cached labels or addresses', () => {
      writeJsonFile(store.path('abcd'), labels);
      writeJsonFile(store.indexPath(), index({ abcd: { labels: { primary: second, ghost: second } } }));
      expect(store.load('abcd')).toEqual(labels);
      expect(store.resolve('ghost', 'abcd')).toBeUndefined();
      expect(store.find(second, 'abcd')).toBeUndefined();
    });

    it('treats a malformed network map as empty', () => {
      store.save({}, 'abcd');
      writeJsonFile(store.path('abcd'), []);
      expect(store.load('abcd')).toEqual({});
    });

    it('removes emptied index entries while preserving other networks', () => {
      store.set('primary', first);
      store.set('secondary', second, TESTNET);
      expect(store.remove('missing', TESTNET)).toBe(false);
      expect(store.remove('primary')).toBe(true);
      expect(store.load()).toEqual({});
      expect(store.load(TESTNET)).toEqual({ secondary: second });
      expect(store.loadIndex()).toEqual(index({ [TESTNET]: { labels: { secondary: second } } }));
      expect(store.remove('secondary', TESTNET)).toBe(true);
      expect(store.load(TESTNET)).toEqual({});
      expect(store.loadIndex()).toEqual(index({}));
    });

    it('finds label and address scopes from configured network files', () => {
      store.set('primary', first, MAINNET);
      store.set('primary', second, TESTNET);
      const match = { scope: 'network', network: 'mainnet', caip2Ref: MAINNET, label: 'primary', address: first };
      expect(store.labelScopes('primary')).toEqual([
        match, { ...match, network: 'testnet', caip2Ref: TESTNET, address: second },
      ]);
      expect(store.addressScopes(first)).toEqual([match]);
    });

    it('rebuilds from configured files, replacing stale cached entries', () => {
      store.save(labels, MAINNET);
      store.save({ primary: second }, TESTNET);
      writeJsonFile(store.indexPath(), index({ stale: { labels } }));
      const expected = index({ [MAINNET]: { labels }, [TESTNET]: { labels: { primary: second } } });
      expect(store.rebuild()).toEqual(expected);
      expect(readJsonFile(store.indexPath())).toEqual(expected);
      expect(existsSync(store.path('stale'))).toBe(false);
    });

    it('omits configured networks whose authoritative map is empty when rebuilding', () => {
      store.save(labels, MAINNET);
      expect(store.rebuild()).toEqual(index({ [MAINNET]: { labels } }));
    });
  });
}

accountLabelStoreTests('account-label persistence', {
  path: config.getAccountLabelsPathForNetwork, indexPath: config.getAccountLabelsPath,
  load: config.loadAccountLabels, save: config.saveAccountLabels, loadIndex: config.loadAccountLabelsIndex,
  rebuild: config.rebuildAccountLabelsIndex,
  set: (label, address, ref) => config.setAccountLabel({ address, label, mode: 'hard' }, ref),
  remove: config.removeAccountLabel,
  resolve: (label, ref) => config.resolveAccountLabel(label, ref)?.address,
  find: config.findAccountLabelForAddress,
  labelScopes: config.findAccountLabelScopes, addressScopes: config.findAddressLabelScopes,
}, '4MainnetAccount', '3TestnetAccount');

import { describe, expect, it } from 'vitest';
import { createResourceCatalog } from '../../../../src/mcp/resourcePlumbing/resourceCatalog.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { useTestXdg, useUnsetEnv } from '../../../helpers/xdg.js';

const NETWORK_RESOURCE_DEFAULTS = [
  ['account-default', 'ccd://account/{account}'],
  ['passive-delegation-default', 'ccd://delegation/passive'],
  ['block-default', 'ccd://block/{id}'],
  ['contract-instance-default', 'ccd://contract-instance/{addressOrLabel}'],
  ['locks-default', 'ccd://locks'],
  ['plt-catalogue-default', 'ccd://plts'],
  ['chain-capabilities-default', 'ccd://chain/capabilities'],
] as const;

const LOCAL_RESOURCE_URIS = ['ccd://networks', 'skill://ccd-network-discovery/SKILL.md'] as const;

const REMOVED_RESOURCE_URIS = [
  'ccd://walletconnect/connections',
  'ccd://walletconnect/connection/{connectionId}',
  'skill://concordium-account-opening/SKILL.md',
] as const;

describe('createResourceCatalog', () => {
  useTestXdg('resource-catalog-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  useUnsetEnv('CCD_NETWORK');

  it('includes each chain domain and global resource group', () => {
    const catalog = createResourceCatalog(makeContext(new FakeConcordiumClient()));

    expect(catalog).toEqual(
      expect.arrayContaining(NETWORK_RESOURCE_DEFAULTS.map(([name, uri]) => expect.objectContaining({ name, uri }))),
    );
    expect(catalog.map(({ uri }) => uri)).toEqual(expect.arrayContaining([...LOCAL_RESOURCE_URIS]));
    for (const uri of REMOVED_RESOURCE_URIS) expect(catalog.map((resource) => resource.uri)).not.toContain(uri);
  });

  it('publishes unambiguous resource names and URIs', () => {
    const catalog = createResourceCatalog(makeContext(new FakeConcordiumClient()));

    expect(new Set(catalog.map(({ name }) => name)).size).toBe(catalog.length);
    expect(new Set(catalog.map(({ uri }) => uri)).size).toBe(catalog.length);
  });
});

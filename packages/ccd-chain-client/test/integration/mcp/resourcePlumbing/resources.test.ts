import { setAccountCredentialObservation, type AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { caip2Reference, ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResourceCatalog } from '../../../../src/mcp/resourcePlumbing/resourceCatalog.js';
import { accountResourceFamilies } from '../../../../src/mcp/accounts/resourceDefinitions.js';
import { installAccountLabelsFixture } from '../../../helpers/accountLabels.js';
import { readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const MAINNET_REF = caip2Reference('ccd:9dd9ca4d19e9393877d2c44b70f89acb');

function findResource(ctx: Parameters<typeof createResourceCatalog>[0], uri: string) {
  const resource = createResourceCatalog(ctx).find((candidate) => candidate.uri === uri);
  if (resource === undefined) throw new Error(`Missing resource ${uri}`);
  return resource;
}

function jsonOf(result: { text: string }): unknown {
  return JSON.parse(result.text) as unknown;
}

function observation(): AccountCredentialObservation {
  return {
    accountThreshold: '1',
    credentials: {
      '0': {
        threshold: '1',
        keys: { '0': { publicKey: ed25519PublicKey.require('e6'.repeat(32)), scheme: 'Ed25519' } },
      },
    },
    sourceBlock: { hash: '11'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
  };
}

describe('resource integration', () => {
  let root: string;
  let restoreAccountLabels = () => {};
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousDataHome = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    root = makeTestTempDir('mcp-resources-');
    process.env.XDG_STATE_HOME = root;
    process.env.XDG_DATA_HOME = `${root}/data`;
    restoreAccountLabels = installAccountLabelsFixture(MAINNET_REF, { listed: ADDRESS }, 'ccd-resource-integration');
  });

  afterEach(() => {
    restoreAccountLabels();
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the startup-captured default in the network resource', async () => {
    const ctx = makeContext(new FakeConcordiumClient(), { network: 'testnet', defaultNetworkSource: 'session' });

    const body = jsonOf(await findResource(ctx, 'ccd://networks').read('ccd://networks')) as {
      defaultNetwork: string;
      defaultNetworkSource: string;
    };

    expect(body).toMatchObject({ defaultNetwork: 'testnet', defaultNetworkSource: 'session' });
  });

  it('reads named account credentials from real cache storage without a node query', async () => {
    const cached = observation();
    setAccountCredentialObservation(ADDRESS, cached, MAINNET_REF);
    const client = new FakeConcordiumClient();
    const ctx = makeContext(client);

    const body = await readDomainResource(accountResourceFamilies(), 'account-credentials', ctx, {
      network: 'mainnet',
      parameters: { account: 'listed' },
    });

    expect(body).toMatchObject({
      address: ADDRESS,
      label: 'listed',
      accountThreshold: '1',
    });
    expect(client.calls.getFinalizedAccountCredentials ?? 0).toBe(0);
  });

  it('serves packaged workflow markdown through the resource catalog', async () => {
    const ctx = makeContext(new FakeConcordiumClient());
    const resource = findResource(ctx, 'skill://ccd-transfer/SKILL.md');

    await expect(resource.list?.()).resolves.toEqual([
      { uri: 'skill://ccd-transfer/SKILL.md', name: 'ccd-transfer' },
    ]);
    await expect(resource.read('skill://ccd-transfer/SKILL.md')).resolves.toMatchObject({
      mimeType: 'text/markdown',
      text: expect.stringContaining('build_transfer'),
    });
  });

  it('serves account-label discovery guidance without operator-only instruction bleed', async () => {
    const ctx = makeContext(new FakeConcordiumClient());
    const resource = findResource(ctx, 'skill://ccd-account-label-discovery/SKILL.md');
    const result = await resource.read('skill://ccd-account-label-discovery/SKILL.md');

    expect(result.text).toContain('ccd://account-labels');
    expect(result.text).not.toContain('ccd://account-labels/management-guidance');
    expect(result.text).not.toMatch(/account-label (set|remove)|hard labels?/i);
    expect(result.text).not.toMatch(/present .* to the user before/i);
    expect(result.text).toMatch(/verify the resolved network, labels?, and addresses? before us/i);
  });
});

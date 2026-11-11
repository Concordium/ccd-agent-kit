import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AccountAddress } from '@concordium/web-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findLabelForAccount,
  resolveAccountInput,
  sameAccount,
} from '../../../../src/mcp/accounts/accountLabels.js';
import { installAccountLabelsFixture } from '../../../helpers/accountLabels.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const OTHER = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
const MAINNET_CAIP2 = '9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET_CAIP2 = '4221332d34e1694168c2a0c0b3fd0f27';
const DEVNET_CAIP2 = '11111111111111111111111111111111';

describe('account labels', () => {
  const previousDataHome = process.env.XDG_DATA_HOME;
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  let restoreAccountLabels = () => {};
  let tempDir: string | undefined;

  afterEach(() => {
    restoreAccountLabels();
    restoreAccountLabels = () => {};
    if (previousDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousDataHome;
    }
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('compares account identity across aliases', () => {
    const alias = AccountAddress.getAlias(AccountAddress.fromBase58(ADDRESS), 1).toString();

    expect(sameAccount(ADDRESS, ADDRESS)).toBe(true);
    expect(sameAccount(ADDRESS, alias)).toBe(true);
    expect(sameAccount(ADDRESS, OTHER)).toBe(false);
    expect(sameAccount(ADDRESS, 'not-an-address')).toBe(false);
  });

  it('finds account labels through address aliases', () => {
    restoreAccountLabels = installAccountLabelsFixture(MAINNET_CAIP2, { listed: ADDRESS }, 'ccd-account-alias-test');

    const alias = AccountAddress.getAlias(AccountAddress.fromBase58(ADDRESS), 1).toString();
    expect(findLabelForAccount(alias, 'mainnet')).toBe('listed');
    expect(findLabelForAccount(OTHER, 'mainnet')).toBeUndefined();
  });

  it('passes through valid account addresses without account-label lookup', () => {
    expect(resolveAccountInput(ADDRESS, 'mainnet')).toBe(ADDRESS);
  });

  it('prefers exact configured address matches before alias matches', () => {
    const alias = AccountAddress.getAlias(AccountAddress.fromBase58(ADDRESS), 1).toString();
    restoreAccountLabels = installAccountLabelsFixture(
      MAINNET_CAIP2,
      { exact: ADDRESS, alias },
      'ccd-account-exact-test',
    );

    expect(findLabelForAccount(ADDRESS, 'mainnet')).toBe('exact');
  });

  it('reports when an account label exists on another network', () => {
    tempDir = installAccountLabels({ [TESTNET_CAIP2]: { listed: ADDRESS } });

    expect(() => resolveAccountInput('listed', 'mainnet')).toThrow(
      expect.objectContaining({
        kind: 'invalid-argument',
        message: "Account label 'listed' not found on network 'mainnet'. It exists for testnet.",
      }),
    );
  });

  it('formats multiple other networks in missing account-label diagnostics', () => {
    tempDir = installAccountLabels(
      {
        [TESTNET_CAIP2]: { listed: ADDRESS },
        [DEVNET_CAIP2]: { listed: OTHER },
      },
      {
        devnet: {
          caip2: `ccd:${DEVNET_CAIP2}`,
          genesisHash: DEVNET_CAIP2.padEnd(64, '1'),
          grpc: { host: '127.0.0.1', port: 20000, ssl: false },
        },
      },
    );

    expect(() => resolveAccountInput('listed', 'mainnet')).toThrow(
      expect.objectContaining({
        message: "Account label 'listed' not found on network 'mainnet'. It exists for devnet and testnet.",
      }),
    );
  });
});

function installAccountLabels(
  labelsByNetwork: Record<string, Record<string, string>>,
  configuredNetworks: Record<
    string,
    { caip2: string; genesisHash: string; grpc: { host: string; port: number; ssl: boolean } }
  > = {},
): string {
  const root = makeTestTempDir('ccd-account-labels-tool-');
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  const stateHome = join(root, 'state');
  const accountLabelsDir = join(dataHome, 'ccd-agent-kit', 'account-labels');
  mkdirSync(accountLabelsDir, { recursive: true });

  for (const [networkReference, labels] of Object.entries(labelsByNetwork)) {
    writeFileSync(join(accountLabelsDir, `${networkReference}.json`), `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
  }

  if (Object.keys(configuredNetworks).length > 0) {
    mkdirSync(join(configHome, 'ccd-agent-kit'), { recursive: true });
    writeFileSync(
      join(configHome, 'ccd-agent-kit', 'networks.json'),
      `${JSON.stringify({ default: 'mainnet', networks: configuredNetworks }, null, 2)}\n`,
      'utf8',
    );
  }

  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_STATE_HOME = stateHome;
  return root;
}

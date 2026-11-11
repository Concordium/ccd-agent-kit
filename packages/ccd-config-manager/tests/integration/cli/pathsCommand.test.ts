import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAccountCredentialsPathForNetwork, getAccountLabelsPathForNetwork } from '@ccd-agent-kit/config-utils';
import { runPathsCommand } from '../../../src/cli/pathsCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const TESTNET_REF = '4221332d34e1694168c2a0c0b3fd0f27';

describe('paths command integration', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-paths-');
  });

  afterEach(() => env.restore());

  it('prints shared paths scoped to an explicitly resolved network', async () => {
    expect(await runPathsCommand({ request: { network: 'testnet' }, ...env })).toBe(0);
    const output = env.stdout.join('\n');
    expect(output).toContain('Name:           testnet');
    expect(output).toContain(getAccountLabelsPathForNetwork(TESTNET_REF));
    expect(output).toContain('Account labels [data]');
    expect(output).toContain('Account label index [state]');
    expect(output).not.toContain('Account names [data]');
    expect(output).toContain(getAccountCredentialsPathForNetwork(TESTNET_REF));
    expect(output).toContain('used by: ccd-config-manager (w), ccd-signer, ccd-chain-client-mcp');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';

import { loadContractInstanceLabels } from '@ccd-agent-kit/config-utils';
import { registerContractInstanceCliCommand } from '../../../src/cli/contractInstanceCliCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';

describe('contract-instance CLI integration', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-contract-instance-');
  });

  afterEach(() => env.restore());

  it('persists, converts, inspects, and removes a contract-instance label by address', async () => {
    expect((await run(['set', '--address', '12.0', '--label', ' token '])).error).toBeUndefined();
    expect(loadContractInstanceLabels(MAINNET_REF)).toEqual({ token: { index: '12', subindex: '0' } });

    expect((await run(['set', '--address', '12,0', '--mode', 'soft'])).error).toBeUndefined();
    expect(loadContractInstanceLabels(MAINNET_REF)).toEqual({ '@token': { index: '12', subindex: '0' } });

    expect((await run(['set', '--address', '12,0', '--mode', 'hard'])).error).toBeUndefined();
    expect(loadContractInstanceLabels(MAINNET_REF)).toEqual({ token: { index: '12', subindex: '0' } });

    env.stdout.length = 0;
    expect((await run(['inspect', '--label', 'token'])).error).toBeUndefined();
    expect(env.stdout.join('\n')).toContain('Address: 12,0');

    expect((await run(['remove', '--address', '12,0'])).error).toBeUndefined();
    expect(loadContractInstanceLabels(MAINNET_REF)).toEqual({});
  });

  async function run(args: string[]) {
    const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerContractInstanceCliCommand({ program, stdout: env.stdout, stderr: env.stderr });
    let error: unknown;
    try { await program.parseAsync(['contract-instance', 'label', ...args], { from: 'user' }); }
    catch (cause) { error = cause; }
    return { error };
  }
});

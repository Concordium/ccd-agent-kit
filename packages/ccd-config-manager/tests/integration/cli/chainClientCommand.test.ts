import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadChainClientConfig } from '@ccd-agent-kit/config-utils';
import { runChainClientCommand } from '../../../src/cli/chainClientCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

describe('chain client command integration', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-chain-client-');
  });

  afterEach(() => env.restore());

  it('persists and resets startup refresh settings', async () => {
    expect(await runChainClientCommand({
      request: { kind: 'startup-refresh-set', enabled: 'false', maxAge: '7d', concurrency: '5' },
      ...env,
    })).toBe(0);
    expect(loadChainClientConfig().accountCredentials.startupRefresh).toMatchObject({
      concurrency: 5,
      enabled: false,
      maxAge: '7d',
    });

    expect(await runChainClientCommand({ request: { kind: 'startup-refresh-reset' }, ...env })).toBe(0);
    expect(loadChainClientConfig().accountCredentials.startupRefresh.maxAge).toBe('24h');
  });
});

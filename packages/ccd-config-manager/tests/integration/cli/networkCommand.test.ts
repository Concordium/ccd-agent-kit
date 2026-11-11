import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNetwork } from '@ccd-agent-kit/config-utils';
import { runNetworkCommand } from '../../../src/cli/networkCommand.js';
import * as grpc from '../../../src/core/grpc.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

describe('network command integration', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-network-');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it('persists an endpoint update without changing network identity', async () => {
    const before = getNetwork('mainnet')!;
    const queryNodeGenesis = vi.spyOn(grpc, 'autoDetectConnection').mockResolvedValue({
      genesisBlock: before.genesisHash,
      host: 'replacement.example',
      port: 20_001,
      ssl: false,
    });

    expect(
      await run({ kind: 'update', name: 'mainnet', grpcHost: 'replacement.example', grpcPort: '20001' }),
    ).toBe(0);

    expect(queryNodeGenesis).toHaveBeenCalledWith('replacement.example', 20_001);
    expect(getNetwork('mainnet')).toEqual({
      ...before,
      grpc: { host: 'replacement.example', port: 20_001, ssl: false },
    });
  });

  function run(request: Parameters<typeof runNetworkCommand>[0]['request']) {
    return runNetworkCommand({ request, stdout: env.stdout, stderr: env.stderr });
  }
});

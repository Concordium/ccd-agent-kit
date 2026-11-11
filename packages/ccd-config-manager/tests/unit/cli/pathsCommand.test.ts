import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  getAccountCredentialsPathForNetwork: vi.fn(),
  getAccountLabelsPath: vi.fn(),
  getAccountLabelsPathForNetwork: vi.fn(),
  getActiveNetwork: vi.fn(),
  getConfigDir: vi.fn(),
  getDataDir: vi.fn(),
  getNetworksFilePath: vi.fn(),
  getSignerConfigPath: vi.fn(),
  getSignerDataDir: vi.fn(),
  getSignerInventoryPath: vi.fn(),
  getSignerKeyStorageDir: vi.fn(),
  getSignerYubiKeyConfigPath: vi.fn(),
  getStateDir: vi.fn(),
  getYubiKeyRegistrationsPath: vi.fn(),
  resolveNetwork: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', () => config);
vi.mock('../../../src/core/grpc.js', () => ({ caip2Reference: (caip2: string) => caip2.slice(4) }));

import { runPathsCommand } from '../../../src/cli/pathsCommand.js';

describe('runPathsCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const [name, mock] of Object.entries(config)) {
      if (name !== 'getActiveNetwork' && name !== 'resolveNetwork') mock.mockReturnValue(`/paths/${name}`);
    }
    config.getActiveNetwork.mockReturnValue({
      config: { caip2: 'ccd:mainnet' },
      name: 'mainnet',
      source: 'config',
    });
    config.resolveNetwork.mockReturnValue({ config: { caip2: 'ccd:testnet' }, name: 'testnet' });
  });

  it('renders active-network metadata and each producer path', async () => {
    const result = await run({});
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('Default source: config');
    expect(result.stdout.join('\n')).toContain('/paths/getNetworksFilePath');
    expect(result.stdout.join('\n')).toContain('Account labels [data]');
    expect(result.stdout.join('\n')).toContain('Account label index [state]');
    expect(config.getAccountLabelsPathForNetwork).toHaveBeenCalledWith('mainnet');
  });

  it('uses explicit and session producer metadata without local re-resolution', async () => {
    const explicit = await run({ network: 'testnet' });
    expect(explicit.stdout.join('\n')).toContain('Default source: explicit');
    expect(config.resolveNetwork).toHaveBeenCalledWith('testnet');

    config.getActiveNetwork.mockReturnValueOnce({
      config: { caip2: 'ccd:testnet' },
      name: 'testnet',
      source: 'session',
    });
    expect((await run({})).stdout.join('\n')).toContain('Default source: session (CCD_NETWORK)');
  });

  it('maps network producer errors to usage failures', async () => {
    config.resolveNetwork.mockImplementationOnce(() => {
      throw new Error("Network 'missing' not found.");
    });
    expect(await run({ network: 'missing' })).toEqual({
      code: 2,
      stderr: ["Network 'missing' not found."],
      stdout: [],
    });
  });
});

async function run(request: Parameters<typeof runPathsCommand>[0]['request']) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runPathsCommand({ request, stdout, stderr });
  return { code, stderr, stdout };
}

import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../../src/config.js';
import { createCachingNetworkClientProvider } from '../../../../src/mcp/toolPlumbing/networkClient.js';

function config(env: Record<string, string> = {}) {
  const parsed = parseConfig(env);
  if (!parsed.ok) throw new Error(parsed.errors.join(', '));
  return parsed.value;
}

describe('network client provider', () => {
  it('creates clients lazily and caches by resolved network', () => {
    const provider = createCachingNetworkClientProvider(config());

    const mainnet = provider.getClient();
    expect(mainnet.networkName).toBe('mainnet');
    expect(provider.getClient('mainnet').client).toBe(mainnet.client);
    expect(provider.getClient('9dd9ca4d19e9393877d2c44b70f89acb').client).toBe(mainnet.client);

    const testnet = provider.getClient('testnet');
    expect(testnet.networkName).toBe('testnet');
    expect(testnet.client).not.toBe(mainnet.client);
    expect(provider.getClient('testnet').client).toBe(testnet.client);
  });

  it('propagates network resolution failures', () => {
    const provider = createCachingNetworkClientProvider(config());

    expect(() => provider.getClient('missing')).toThrow("Network 'missing'");
  });
});

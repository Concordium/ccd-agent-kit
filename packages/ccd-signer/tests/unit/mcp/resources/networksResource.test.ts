import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveNetwork, loadNetworks } from '@ccd-agent-kit/config-utils';
import {
  formatNetworksResource,
  networksResource,
  readNetworksResource,
} from '../../../../src/mcp/resources/networksResource.js';

vi.mock('@ccd-agent-kit/config-utils', () => ({ getActiveNetwork: vi.fn(), loadNetworks: vi.fn() }));

describe('networksResource', () => {
  beforeEach(() => {
    vi.mocked(getActiveNetwork).mockReset().mockReturnValue({
      config: { caip2: 'ccd:dev', genesisHash: '11'.repeat(32), grpc: { host: 'dev', port: 1, ssl: false } },
      name: 'devnet', source: 'session',
    });
    vi.mocked(loadNetworks).mockReset().mockReturnValue({
      default: 'mainnet',
      networks: {
        testnet: { caip2: 'ccd:test', genesisHash: '22'.repeat(32), grpc: { host: 'test', port: 2, ssl: true } },
        devnet: { caip2: 'ccd:dev', genesisHash: '11'.repeat(32), grpc: { host: 'dev', port: 1, ssl: false } },
      },
    });
  });

  it('declares stable public metadata', () => {
    expect(networksResource).toEqual({
      description: 'Configured Concordium networks and the active default network.',
      mimeType: 'application/json',
      name: 'ccd://networks',
      title: 'Concordium Signer Networks',
      uri: 'ccd://networks',
    });
  });

  it('captures the active default once and projects a sorted safe network catalogue', () => {
    expect(formatNetworksResource()).toEqual({
      defaultNetwork: 'devnet',
      defaultNetworkSource: 'session',
      networks: [{ name: 'devnet', caip2: 'ccd:dev' }, { name: 'testnet', caip2: 'ccd:test' }],
    });
    expect(getActiveNetwork).toHaveBeenCalledOnce();
    expect(loadNetworks).toHaveBeenCalledOnce();
  });

  it('wraps the projection as JSON MCP resource content', () => {
    const result = readNetworksResource('ccd://networks');

    expect(result).toEqual({
      uri: 'ccd://networks', mimeType: 'application/json',
      text: JSON.stringify(formatNetworksResource(), null, 2),
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  findForAddress: vi.fn(),
  findScopes: vi.fn(),
  load: vi.fn(),
  resolveLabel: vi.fn(),
  resolveNetwork: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  findContractInstanceLabelForAddress: config.findForAddress,
  findContractInstanceLabelScopes: config.findScopes,
  loadContractInstanceLabels: config.load,
  resolveContractInstanceLabel: config.resolveLabel,
  resolveNetwork: config.resolveNetwork,
}));

import {
  listContractInstanceLabelsForNetwork,
  resolveContractInstanceInput,
  resolveContractInstanceUriSegment,
} from '../../../../src/mcp/contracts/contractInstanceLabels.js';

const TESTNET_REF = '22'.repeat(16);

describe('contract instance label resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.resolveNetwork.mockImplementation((network = 'testnet') => ({
      name: network,
      config: {
        caip2: `ccd:${TESTNET_REF}`,
        genesisHash: '00'.repeat(32),
        grpc: { host: 'localhost', port: 20_000, ssl: false },
      },
    }));
    config.findScopes.mockReturnValue([]);
  });

  it.each(['7,1', '7.1'])('canonicalizes raw address input %s and attaches its local label', (input) => {
    config.findForAddress.mockReturnValue('counter');

    expect(resolveContractInstanceInput(input, 'testnet')).toEqual({
      index: 7n,
      subindex: 1n,
      address: { index: '7', subindex: '1' },
      canonical: '7,1',
      label: 'counter',
    });
    expect(config.resolveLabel).not.toHaveBeenCalled();
    expect(config.findForAddress).toHaveBeenCalledWith({ index: '7', subindex: '1' }, TESTNET_REF);
  });

  it('resolves a label in only the selected network and preserves it as metadata', () => {
    config.resolveLabel.mockReturnValue({ index: '42', subindex: '0' });
    config.findForAddress.mockReturnValue('Counter');

    expect(resolveContractInstanceInput('counter', 'testnet')).toMatchObject({
      address: { index: '42', subindex: '0' },
      canonical: '42,0',
      label: 'Counter',
    });
    expect(config.resolveLabel).toHaveBeenCalledWith('counter', TESTNET_REF);
    expect(config.findForAddress).toHaveBeenCalledWith({ index: '42', subindex: '0' }, TESTNET_REF);
  });

  it('URI-decodes labels but leaves ordinary tool input raw', () => {
    config.resolveLabel.mockImplementation((label) =>
      label === 'encoded-label' ? { index: '3', subindex: '2' } : undefined,
    );

    expect(resolveContractInstanceUriSegment('encoded%2Dlabel', 'testnet').canonical).toBe('3,2');
    expect(() => resolveContractInstanceInput('encoded%2Dlabel', 'testnet')).toThrow();
  });

  it('returns trimmed bare label metadata after resolving a whitespace-padded selector', () => {
    config.resolveLabel.mockReturnValue({ index: '42', subindex: '0' });
    config.findForAddress.mockReturnValue('Counter');

    expect(resolveContractInstanceInput('  counter  ', 'testnet')).toMatchObject({
      canonical: '42,0', label: 'Counter',
    });
    expect(resolveContractInstanceUriSegment('%20counter%20', 'testnet').label).toBe('Counter');
  });

  it('diagnoses same-label matches on other networks using the scope label field', () => {
    config.resolveLabel.mockReturnValue(undefined);
    config.findScopes.mockReturnValue([
      {
        scope: 'network',
        network: 'mainnet',
        caip2Ref: '11'.repeat(16),
        label: 'counter',
        address: { index: '1', subindex: '0' },
      },
      {
        scope: 'network',
        network: 'staging',
        caip2Ref: '33'.repeat(16),
        label: 'counter',
        address: { index: '2', subindex: '0' },
      },
    ]);

    expect(() => resolveContractInstanceInput('counter', 'testnet')).toThrow(
      expect.objectContaining({
        kind: 'invalid-argument',
        message: expect.stringMatching(/mainnet.*staging|staging.*mainnet/),
      }),
    );
  });

  it('loads the selected network label catalog', () => {
    config.load.mockReturnValue({ counter: { index: '7', subindex: '0' } });
    expect(listContractInstanceLabelsForNetwork('testnet')).toEqual({ counter: { index: '7', subindex: '0' } });
    expect(config.load).toHaveBeenCalledWith(TESTNET_REF);
  });
});

import { CatalogLabelError } from '@ccd-agent-kit/config-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const collaborators = vi.hoisted(() => ({
  resolveNetwork: vi.fn(),
  writeLabel: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  resolveNetwork: collaborators.resolveNetwork,
  setSoftContractInstanceLabel: collaborators.writeLabel,
}));
import { labelContractInstanceTool } from '../../../../src/mcp/contracts/tools/labelContractInstanceTool.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const MAINNET_REF = '11'.repeat(16);

describe('contract instance soft label tool', () => {
  const context = makeContext(new FakeConcordiumClient(), { network: 'testnet' });
  const getClient = vi.spyOn(context.clients, 'getClient');

  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.resolveNetwork.mockImplementation((network: string) => ({
      name: network === 'testnet' ? 'testnet' : 'mainnet',
      config: {
        caip2: `ccd:${MAINNET_REF}`,
        genesisHash: '00'.repeat(32),
        grpc: { host: 'localhost', port: 20_000, ssl: false },
      },
    }));
  });

  it('canonicalizes the address and network, writes only local metadata, and returns no mode', async () => {
    const args = labelContractInstanceTool.inputSchema.parse({
      address: '0007.01',
      label: '  Counter  ',
      network: `ccd:${MAINNET_REF}`,
    });
    const result = await labelContractInstanceTool.handler(context, args);

    expect(collaborators.resolveNetwork).toHaveBeenCalledWith(`ccd:${MAINNET_REF}`);
    expect(collaborators.writeLabel).toHaveBeenCalledWith('Counter', { index: '7', subindex: '1' }, MAINNET_REF);
    expect(result.structuredContent).toEqual({ address: '7,1', label: 'Counter', network: 'mainnet' });
    expect(result.structuredContent).not.toHaveProperty('mode');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('removes an existing soft label without a chain call', async () => {
    const args = labelContractInstanceTool.inputSchema.parse({ address: '7,1', remove: true });
    const result = await labelContractInstanceTool.handler(context, args);

    expect(collaborators.writeLabel).toHaveBeenCalledWith(undefined, { index: '7', subindex: '1' }, MAINNET_REF);
    expect(result.structuredContent).toEqual({ address: '7,1', network: 'testnet' });
    expect(getClient).not.toHaveBeenCalled();
  });

  it('reports hard-label protection with the stable code', async () => {
    collaborators.writeLabel.mockImplementation(() => {
      throw new CatalogLabelError('LABEL_PROTECTED');
    });

    const result = await labelContractInstanceTool.handler(context, { address: '7,1', label: 'Counter' });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { kind: 'invalid-argument', message: 'LABEL_PROTECTED' } },
    });
  });

  it('sanitizes catalog collisions and local path failures', async () => {
    collaborators.writeLabel.mockImplementation(() => {
      throw new Error('Duplicate label in /protected/contract-instance-labels.json');
    });

    const result = await labelContractInstanceTool.handler(context, { address: '7,1', label: 'Counter' });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toMatch(/Duplicate|protected|contract-instance-labels\.json/);
  });

  it('sanitizes a typed label collision without misreporting protection', async () => {
    collaborators.writeLabel.mockImplementation(() => { throw new CatalogLabelError('DUPLICATE_LABEL'); });
    const result = await labelContractInstanceTool.handler(context, { address: '7,1', label: 'Counter' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DUPLICATE_LABEL|LABEL_PROTECTED/);
  });

  it('validates the shared action before the handler can mutate a label', async () => {
    const result = await labelContractInstanceTool.handler(context, { address: '7,1', label: 'Counter', remove: true });
    expect(result.isError).toBe(true);
    expect(collaborators.writeLabel).not.toHaveBeenCalled();
  });

  it('rejects a label where a native contract address is required without writing', async () => {
    const result = await labelContractInstanceTool.handler(context, { address: 'Counter', label: 'Counter' });
    expect(result.isError).toBe(true);
    expect(collaborators.writeLabel).not.toHaveBeenCalled();
  });

});

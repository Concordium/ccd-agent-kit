import type { resolveNetwork, setSoftAccountLabel } from '@ccd-agent-kit/config-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const collaborators = vi.hoisted(() => ({
  resolveAccountInput: vi.fn<(input: string, network?: string) => string>(),
  resolveNetwork: vi.fn<typeof resolveNetwork>(),
  writeLabel: vi.fn<typeof setSoftAccountLabel>(),
}));
vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  resolveNetwork: collaborators.resolveNetwork,
  setSoftAccountLabel: collaborators.writeLabel,
}));
vi.mock('../../../../src/mcp/accounts/accountLabels.js', () => ({
  resolveAccountInput: collaborators.resolveAccountInput,
}));

import { labelAccountTool } from '../../../../src/mcp/accounts/tools/labelAccountTool.js';
import { CatalogLabelError } from '@ccd-agent-kit/config-utils';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const address = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const mainnet = '9dd9ca4d19e9393877d2c44b70f89acb';

describe('account soft label tool', () => {
  const context = makeContext(new FakeConcordiumClient());
  const getClient = vi.spyOn(context.clients, 'getClient');

  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.resolveAccountInput.mockImplementation((input) => input);
    collaborators.resolveNetwork.mockReturnValue({
      name: 'mainnet',
      config: {
        caip2: `ccd:${mainnet}`,
        genesisHash: mainnet.padEnd(64, '0'),
        grpc: { host: 'node.example', port: 20000, ssl: true },
      },
    });
  });

  it('writes only local network-scoped metadata and returns a safe summary', async () => {
    const args = labelAccountTool.inputSchema.parse({ address, label: '  Spending  ' });
    const result = await labelAccountTool.handler(context, args);
    expect(collaborators.resolveAccountInput).toHaveBeenCalledWith(address, 'mainnet');
    expect(collaborators.writeLabel).toHaveBeenCalledWith('Spending', address, mainnet);
    expect(result.structuredContent).toEqual({ address, label: 'Spending', network: 'mainnet' });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(result.structuredContent, null, 2),
    });
    expect(getClient).not.toHaveBeenCalled();
  });

  it('supports soft label removal without an account mutation', async () => {
    const args = labelAccountTool.inputSchema.parse({ address, remove: true });
    const result = await labelAccountTool.handler(context, args);
    expect(collaborators.writeLabel).toHaveBeenCalledWith(undefined, address, mainnet);
    expect(result.structuredContent).toEqual({ address, network: 'mainnet' });
    expect(getClient).not.toHaveBeenCalled();
  });

  it('reports hard label protection as an MCP tool error', async () => {
    collaborators.writeLabel.mockImplementation(() => {
      throw new CatalogLabelError('LABEL_PROTECTED');
    });
    const result = await labelAccountTool.handler(context, { address, label: 'Spending' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { kind: 'invalid-argument', message: 'LABEL_PROTECTED' },
    });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'LABEL_PROTECTED' });
  });

  it('does not disclose local catalog paths in errors', async () => {
    collaborators.writeLabel.mockImplementation(() => {
      throw new Error('EACCES: open /protected/account-locations.json');
    });
    const result = await labelAccountTool.handler(context, { address, label: 'Spending' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Tool operation failed.' });
    expect(JSON.stringify(result)).not.toMatch(/protected|account-locations|EACCES/);
  });

  it('sanitizes a typed label collision without misreporting protection', async () => {
    collaborators.writeLabel.mockImplementation(() => { throw new CatalogLabelError('DUPLICATE_LABEL'); });
    const result = await labelAccountTool.handler(context, { address, label: 'Spending' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DUPLICATE_LABEL|LABEL_PROTECTED/);
  });

  it('validates the shared action before the handler can mutate a label', async () => {
    const result = await labelAccountTool.handler(context, { address });
    expect(result.isError).toBe(true);
    expect(collaborators.writeLabel).not.toHaveBeenCalled();
  });
});

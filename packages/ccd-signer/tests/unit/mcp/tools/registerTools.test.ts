import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerAllSignerTools } from '../../../../src/mcp/tools/registerTools.js';
import { createSignerToolRegistry } from '../../../../src/mcp/tools/toolRegistry.js';

const handlers = vi.hoisted(() => ({ credential: vi.fn(), message: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../../src/mcp/tools/signTransactionTool.js', () => ({
  executeSignTransactionTool: handlers.transaction, signTransactionTool: { name: 'sign_transaction' },
}));
vi.mock('../../../../src/mcp/tools/signCredentialDeploymentTool.js', () => ({
  executeSignCredentialDeploymentTool: handlers.credential,
  signCredentialDeploymentTool: { name: 'sign_credential' },
}));
vi.mock('../../../../src/mcp/tools/signMessageTool.js', () => ({
  executeSignMessageTool: handlers.message, signMessageTool: { name: 'sign_message' },
}));

describe('registerAllSignerTools adapter behavior', () => {
  beforeEach(() => {
    handlers.credential.mockReset();
    handlers.message.mockReset();
    handlers.transaction.mockReset();
  });

  it('forwards parsed arguments and the optional service to signing handlers', async () => {
    const registry = registerAllSignerTools(createSignerToolRegistry());
    const cases = [
      ['sign_transaction', { transactionHex: 'aa', role: 'sender' }, handlers.transaction],
      ['sign_credential', { credDeploymentHex: 'bb' }, handlers.credential],
      ['sign_message', { account: 'alice', messageText: 'hello' }, handlers.message],
    ] as const;

    for (const [name, arguments_, handler] of cases) {
      await registry.get(name)?.handler(arguments_);
      expect(handler).toHaveBeenCalledWith(arguments_, undefined);
    }
  });
});

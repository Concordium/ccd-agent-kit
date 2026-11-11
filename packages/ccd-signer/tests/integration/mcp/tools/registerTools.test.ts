import { describe, expect, it } from 'vitest';

import { registerAllSignerTools } from '../../../../src/mcp/tools/registerTools.js';
import { createSignerToolRegistry } from '../../../../src/mcp/tools/toolRegistry.js';

describe('registerAllSignerTools', () => {
  it('registers the public signer MCP tool catalog', () => {
    const registry = registerAllSignerTools(createSignerToolRegistry());

    expect(registry.list().map((tool) => tool.name)).toEqual([
      'label_signing_key',
      'describe_transaction',
      'sign_transaction',
      'sign_credential',
      'sign_message',
    ]);
    expect(registry.get('label_signing_material')).toBeUndefined();
  });

  it('exposes validation schemas for signer tools', () => {
    const registry = registerAllSignerTools(createSignerToolRegistry());
    const labelSchema = registry.get('label_signing_key')?.inputSchema;

    expect(registry.get('describe_transaction')?.inputSchema.parse({ transactionHex: 'abcd' })).toEqual({
      transactionHex: 'abcd',
    });
    expect(labelSchema?.parse({ keyRef: `ed25519:${'ab'.repeat(32)}`, label: '  Spending  ' })).toEqual({
      keyRef: `ed25519:${'ab'.repeat(32)}`,
      label: 'Spending',
    });
    expect(labelSchema?.parse({ keyRef: `ed25519:${'ab'.repeat(32)}`, remove: true })).toEqual({
      keyRef: `ed25519:${'ab'.repeat(32)}`,
      remove: true,
    });
    expect(labelSchema?.safeParse({ keyRef: `ed25519:${'ab'.repeat(32)}`, remove: false }).success).toBe(false);
    expect(() => registry.get('sign_message')?.inputSchema.parse({ account: 'alice' })).toThrow(
      'Provide exactly one of messageText or messageHex.',
    );
    expect(registry.get('sign_credential')?.inputSchema.parse({ credDeploymentHex: 'abcd' })).toMatchObject({
      credDeploymentHex: 'abcd',
    });
    expect(registry.get('sign_credential')?.inputSchema.safeParse({ transactionHex: 'abcd' }).success).toBe(false);
    expect(registry.get('sign_credential_deployment')).toBeUndefined();
  });

  it('attaches output schemas where the MCP tool declares structured output', () => {
    const registry = registerAllSignerTools(createSignerToolRegistry());
    const signMessageOutput = registry.get('sign_message')?.outputSchema;

    expect(registry.get('describe_transaction')?.outputSchema).toBeDefined();
    expect(registry.get('sign_transaction')?.outputSchema).toBeDefined();
    expect(registry.get('sign_credential')?.outputSchema).toBeDefined();
    expect(signMessageOutput).toBeDefined();
    expect(signMessageOutput?.parse({
      account: 'address', inputFormat: 'text', label: 'alice', network: 'mainnet', signature: {},
    })).toMatchObject({ label: 'alice' });
    expect(registry.get('label_signing_key')?.outputSchema).toBeDefined();
  });
});

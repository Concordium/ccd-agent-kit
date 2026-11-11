import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../../../../src/mcp/toolPlumbing/toolTypes.js';
import { simulateContractArgsSchema } from '../../../../src/mcp/contracts/handlers.js';
import { jsonTool, toolError } from '../../../../src/mcp/toolPlumbing/toolHandlers.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

function textOf(result: ToolResult): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

function jsonOf(result: ToolResult): unknown {
  return JSON.parse(textOf(result));
}

describe('tool handlers', () => {
  it('simulateContractArgsSchema accepts null JSON parameters and rejects non-JSON parameters', () => {
    expect(
      simulateContractArgsSchema.safeParse({
        contract: '1,0',
        method: 'demo.receive',
      }).success,
    ).toBe(true);

    expect(
      simulateContractArgsSchema.safeParse({
        contract: '1,0',
        method: 'demo.receive',
        parameterHex: '00',
      }).success,
    ).toBe(true);

    expect(
      simulateContractArgsSchema.safeParse({
        contract: '1,0',
        method: 'demo.receive',
        parameterHex: '00',
        parameterJson: null,
      }).success,
    ).toBe(false);

    expect(
      simulateContractArgsSchema.safeParse({
        contract: '1,0',
        method: 'demo.receive',
        parameterJson: null,
      }).success,
    ).toBe(true);

    expect(
      simulateContractArgsSchema.safeParse({
        contract: '1,0',
        method: 'demo.receive',
        parameterJson: () => true,
      }).success,
    ).toBe(false);
  });

  it('toolError sanitizes unknown errors and leaves them unstructured', () => {
    const result = toolError(
      new Error('failed to read /Users/operator/.local/share/ccd-agent-kit/wallet.json: private-key=super-secret'),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Tool operation failed.');
    expect(textOf(result)).not.toContain('/Users/operator');
    expect(textOf(result)).not.toContain('super-secret');
    expect(result.structuredContent).toBeUndefined();
  });

  it('toolError projects only public fields from structured producer errors', () => {
    const result = toolError({ kind: 'node', message: 'unavailable', code: 14, privatePath: '/secret/wallet.json' });
    expect(result.structuredContent).toEqual({ error: { kind: 'node', message: 'unavailable', code: 14 } });
    expect(textOf(result)).toBe('unavailable');

    expect(textOf(toolError({ kind: 'node', message: 'Node https://example.com is unavailable.' }))).toBe(
      'Node https://example.com is unavailable.',
    );

    expect(
      toolError({
        kind: 'chain-capability',
        message: 'unsupported',
        capability: 'lock.info',
        network: 'mainnet',
        privatePath: '/secret/config.json',
      }).structuredContent,
    ).toEqual({
      error: { kind: 'chain-capability', message: 'unsupported', capability: 'lock.info', network: 'mainnet' },
    });
  });

  it.each([
    new Error('LABEL_PROTECTED'),
    new Error('Account label update failed.'),
    { kind: 'conflicting-options', message: 'submit true requires finalization; finalize cannot be false.' },
  ])('toolError does not special-case unstructured failure prose', (error) => {
    const result = toolError(error);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Tool operation failed.');
    expect(result.structuredContent).toBeUndefined();
  });

  it('toolError preserves public URI text from structured producer errors', () => {
    const error = {
      kind: 'invalid-argument' as const,
      message: 'Resource ccd://account/4abc?network=testnet was not found.',
    };
    const result = toolError(error);
    expect(textOf(result)).toBe(error.message);
    expect(result.structuredContent).toEqual({ error });
  });

  it('jsonTool forwards context and arguments and renders JSON-safe results', async () => {
    const ctx = makeContext(new FakeConcordiumClient());
    const handler = jsonTool(async (context, args: { count: bigint }) => {
      expect(context).toBe(ctx);
      return { count: args.count, omitted: undefined, empty: [] };
    });
    const result = await handler(ctx, { count: 2n });
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({ count: '2', empty: [] });
    expect(result.structuredContent).toEqual(jsonOf(result));
  });

  it('jsonTool catches synchronous operation errors', async () => {
    const handler = jsonTool(() => {
      throw new Error('sync failure with password hunter2 at /private/var/ccd/wallet.json');
    });
    const result = await handler(makeContext(new FakeConcordiumClient()), {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Tool operation failed.');
    expect(textOf(result)).not.toContain('hunter2');
    expect(textOf(result)).not.toContain('/private/var');
  });

  it('jsonTool reports rejected operation errors', async () => {
    const handler = jsonTool(async () => {
      throw { kind: 'invalid-argument', message: 'bad build input' };
    });
    const result = await handler(makeContext(new FakeConcordiumClient()), {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'invalid-argument' } });
    expect(textOf(result)).toBe('bad build input');
  });
});

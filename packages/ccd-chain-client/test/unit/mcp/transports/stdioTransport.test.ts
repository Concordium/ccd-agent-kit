import { describe, expect, it, vi } from 'vitest';

let capturedOptions: { onerror(error: Error): void } | undefined;
const serveStdioMock = vi.fn(async (...args: unknown[]) => {
  capturedOptions = args[1] as { onerror(error: Error): void };
  return { close: vi.fn(async () => undefined) };
});

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: serveStdioMock,
}));

describe('stdio transport', () => {
  it('starts stdio serving with error logging', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const serverFactory = vi.fn();
    const { startStdio } = await import('../../../../src/mcp/transports/stdioTransport.js');

    const result = await startStdio(serverFactory);
    const error = new Error('stdio failed');
    capturedOptions?.onerror(error);

    expect(serveStdioMock).toHaveBeenCalledWith(
      serverFactory,
      expect.objectContaining({ onerror: expect.any(Function) }),
    );
    expect(errorSpy).toHaveBeenCalledWith('ccd-chain-client-mcp: stdio error', error);
    await expect(result.close()).resolves.toBeUndefined();

    errorSpy.mockRestore();
  });
});

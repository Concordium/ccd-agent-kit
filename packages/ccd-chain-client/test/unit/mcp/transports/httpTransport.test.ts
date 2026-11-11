import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => {
  const httpServer = {
    listen: vi.fn((_port: number, callback: () => void) => callback()),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    createMcpHandler: vi.fn<(factory: unknown, options: unknown) => { fetch: ReturnType<typeof vi.fn> }>(
      () => ({ fetch: vi.fn() }),
    ),
    createServer: vi.fn(() => httpServer),
    httpServer,
    toNodeHandler: vi.fn(() => vi.fn()),
  };
});

vi.mock('node:http', () => ({ createServer: dependencies.createServer }));
vi.mock('@modelcontextprotocol/node', () => ({ toNodeHandler: dependencies.toNodeHandler }));
vi.mock('@modelcontextprotocol/server', () => ({ createMcpHandler: dependencies.createMcpHandler }));

import { startHttp } from '../../../../src/mcp/transports/httpTransport.js';

describe('HTTP transport startup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names request errors and reports the listening endpoint', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const serverFactory = vi.fn();

    const result = await startHttp({ http: { path: '/rpc', port: 3010 } } as never, serverFactory);
    const options = dependencies.createMcpHandler.mock.calls[0]?.[1] as { onerror(error: Error): void };
    const requestError = new Error('request failed');
    options.onerror(requestError);

    expect(dependencies.createMcpHandler).toHaveBeenCalledWith(
      serverFactory,
      expect.objectContaining({ legacy: 'stateless' }),
    );
    expect(errorLog).toHaveBeenCalledWith('ccd-chain-client-mcp: request handling failed', requestError);
    expect(errorLog).toHaveBeenCalledWith('ccd-chain-client-mcp: Streamable HTTP on http://localhost:3010/rpc');
    expect(dependencies.httpServer.listen).toHaveBeenCalledWith(3010, expect.any(Function));
    expect(result).toBe(dependencies.httpServer);
    errorLog.mockRestore();
  });
});

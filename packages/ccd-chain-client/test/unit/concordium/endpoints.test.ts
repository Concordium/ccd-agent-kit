import { describe, expect, it } from 'vitest';
import { resolveEndpoint } from '../../../src/concordium/endpoints.js';

describe('resolveEndpoint', () => {
  it.each([
    ['node.example', true, { host: 'node.example', port: 20000, tls: true }],
    ['127.0.0.1:20001', false, { host: '127.0.0.1', port: 20001, tls: false }],
  ])('parses %s into the effective SDK endpoint', (endpoint, tls, expected) => {
    expect(resolveEndpoint({ grpc: { endpoint, tls } } as never)).toEqual(expected);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { jsonResource, readResource } from '../../../../src/mcp/resourcePlumbing/resourceTypes.js';

describe('readResource', () => {
  it('passes captures verbatim and preserves the domain response', async () => {
    const content = { uri: 'ccd://testnet/account/a%20b/c', ...jsonResource({ empty: [] }) };
    const reader = vi.fn(async () => content);
    const read = readResource(/^ccd:\/\/([^/]+)\/account\/(.+)$/, reader);
    expect(await read('ccd://testnet/account/a%20b/c')).toBe(content);
    expect(reader).toHaveBeenCalledExactlyOnceWith('ccd://testnet/account/a%20b/c', 'testnet', 'a%20b/c');
  });

  it.each(['ccd://wrong', 'ccd://testnet/account'])('rejects invalid or missing captures before domain IO: %s', async (uri) => {
    const reader = vi.fn(async (readUri: string) => ({ uri: readUri, ...jsonResource({}) }));
    const read = readResource(/^ccd:\/\/([^/]+)\/account(?:\/(.+))?$/, reader);
    await expect(read(uri)).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });
});

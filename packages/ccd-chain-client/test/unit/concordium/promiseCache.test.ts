import { describe, expect, it } from 'vitest';
import { PromiseCache } from '../../../src/concordium/cache.js';

describe('bounded module promise cache', () => {
  it('retains a fulfilled undefined result as a cache hit', async () => {
    const cache = new PromiseCache<string, string | undefined>(1);
    const first = cache.load('schema', () => Promise.resolve(undefined));
    await expect(first).resolves.toBeUndefined();
    expect(cache.load('schema', () => Promise.resolve('unexpected reload'))).toBe(first);
  });

  it('does not evict a replacement when an older, evicted load rejects', async () => {
    const cache = new PromiseCache<string, string>(1);
    let reject!: (error: Error) => void;
    const old = cache.load(
      'a',
      () =>
        new Promise<string>((_, fail) => {
          reject = fail;
        }),
    );
    await cache.load('b', () => Promise.resolve('b'));
    const replacement = cache.load('a', () => Promise.resolve('new'));
    const rejected = expect(old).rejects.toThrow('old load');
    reject(new Error('old load'));
    await rejected;
    expect(cache.load('a', () => Promise.resolve('wrong'))).toBe(replacement);
    expect(await replacement).toBe('new');
  });
});

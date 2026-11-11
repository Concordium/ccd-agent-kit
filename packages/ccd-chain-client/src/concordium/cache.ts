/**
 * Bounded LRU cache for plain values.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  /** Evict only the rejected load, never a newer replacement for the same key. */
  deleteIfValue(key: K, value: V): void {
    if (this.entries.get(key) === value) this.entries.delete(key);
  }
}

/**
 * Bounded promise cache. Deduplicates concurrent loads, caches fulfilled results,
 * and evicts rejected entries so failures retry on next read.
 */
export class PromiseCache<K, V> {
  private readonly entries: LruCache<K, Promise<V>>;

  constructor(maxEntries: number) {
    this.entries = new LruCache(maxEntries);
  }

  /** Cache the promise itself, including fulfilled `undefined` and in-flight loads. */
  load(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const loaded = loader().catch((error: unknown) => {
      this.entries.deleteIfValue(key, loaded);
      throw error;
    });
    this.entries.set(key, loaded);
    return loaded;
  }
}

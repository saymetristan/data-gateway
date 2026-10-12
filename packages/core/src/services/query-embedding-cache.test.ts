import { describe, expect, it, vi } from 'vitest';
import { QueryEmbeddingCache, type QueryEmbeddingLoad } from './query-embedding-cache.js';

describe('in-flight embedding provenance', () => {
  it('shares vector and provider metadata but identifies the single outbound call', async () => {
    const cache = new QueryEmbeddingCache();
    let complete!: (value: QueryEmbeddingLoad) => void;
    const loader = vi.fn(() => new Promise<QueryEmbeddingLoad>((resolve) => { complete = resolve; }));
    const first = cache.resolveOrLoadWithMeta('workspace:query', loader);
    const second = cache.resolveOrLoadWithMeta('workspace:query', loader);
    const result: QueryEmbeddingLoad = {
      embedding: [0.1, 0.2],
      providerMeta: {
        attempts: 1, circuitState: 'closed', cacheHeaderEnabled: true,
        providerRouting: 'latency', timedOut: false, skippedByCircuit: false,
      },
    };
    complete(result);
    expect(first.shared).toBe(false);
    expect(second.shared).toBe(true);
    expect(await first.promise).toEqual(result);
    expect(await second.promise).toEqual(result);
    expect(loader).toHaveBeenCalledTimes(1);
    const next = cache.resolveOrLoadWithMeta('workspace:query', async () => ({ embedding: [3, 4] }));
    expect(await next.promise).toEqual({ embedding: [3, 4] });
    expect(next.shared).toBe(false);
  });

  it('does not share provider loads across workspaces and releases failed loads', async () => {
    const cache = new QueryEmbeddingCache();
    const fail = vi.fn(async () => { throw new Error('provider unavailable'); });
    const first = cache.resolveOrLoadWithMeta('a:query', fail);
    const second = cache.resolveOrLoadWithMeta('a:query', fail);
    expect(first.shared).toBe(false);
    expect(second.shared).toBe(true);
    await expect(first.promise).rejects.toThrow('unavailable');
    await expect(second.promise).rejects.toThrow('unavailable');
    const load = vi.fn(async () => ({ embedding: [1] }));
    await Promise.all([cache.resolveOrLoadWithMeta('a:query', load).promise, cache.resolveOrLoadWithMeta('b:query', load).promise]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { awaitEmbeddingWithinHardTimeout } from '../services/query.js';

describe('awaitEmbeddingWithinHardTimeout', () => {
  it('uses embedding when provider finishes between soft and hard budget', async () => {
    vi.useFakeTimers();
    const provider = new Promise<number[]>((resolve) => {
      setTimeout(() => resolve([0.1, 0.2, 0.3, 0.4]), 80);
    });

    const pending = awaitEmbeddingWithinHardTimeout(provider, 50, 200);
    await vi.advanceTimersByTimeAsync(80);
    const result = await pending;

    expect(result).toEqual({
      kind: 'ok',
      value: [0.1, 0.2, 0.3, 0.4],
      slow: true,
    });
    vi.useRealTimers();
  });

  it('returns embedding without slow flag when provider beats soft budget', async () => {
    const result = await awaitEmbeddingWithinHardTimeout(
      Promise.resolve([1, 2, 3]),
      500,
      1_000,
    );
    expect(result).toEqual({ kind: 'ok', value: [1, 2, 3], slow: false });
  });

  it('returns timeout when provider exceeds hard budget (does not abandon at soft)', async () => {
    vi.useFakeTimers();
    const provider = new Promise<number[]>((resolve) => {
      setTimeout(() => resolve([9, 9, 9, 9]), 5_000);
    });

    const pending = awaitEmbeddingWithinHardTimeout(provider, 50, 100);
    // Soft deadline elapses — still waiting.
    await vi.advanceTimersByTimeAsync(50);
    // Hard deadline elapses — now timeout.
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ kind: 'timeout', slow: true });
    vi.useRealTimers();
  });

  it('surfaces provider errors without treating soft miss as fallback', async () => {
    const result = await awaitEmbeddingWithinHardTimeout(
      Promise.reject(Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' })),
      500,
      1_000,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.slow).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});

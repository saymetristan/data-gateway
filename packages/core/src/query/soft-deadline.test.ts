import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../providers/embeddings.js';

/**
 * Soft-deadline race: if provider exceeds soft deadline, query path must not wait.
 * This unit-tests the race helper pattern used by executeQuery.
 */
async function raceWithSoftDeadline<T>(
  promise: Promise<T>,
  softDeadlineMs: number,
): Promise<{ kind: 'ok'; value: T } | { kind: 'deadline' }> {
  return Promise.race([
    promise.then((value) => ({ kind: 'ok' as const, value })),
    new Promise<{ kind: 'deadline' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'deadline' }), softDeadlineMs);
    }),
  ]);
}

class SlowEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'slow';
  readonly dimensions = 4;
  constructor(private readonly delayMs: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  }
}

describe('soft deadline race', () => {
  it('returns deadline when provider is slower than soft budget', async () => {
    vi.useFakeTimers();
    const provider = new SlowEmbeddingProvider(5_000);
    const pending = raceWithSoftDeadline(provider.embed(['tela']), 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ kind: 'deadline' });
    vi.useRealTimers();
  });

  it('returns embedding when provider wins the race', async () => {
    const provider = new SlowEmbeddingProvider(5);
    const result = await raceWithSoftDeadline(provider.embed(['lino']), 500);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCircuitBreakers } from './circuit-breaker.js';
import { OpenRouterEmbeddingProvider } from './embeddings.js';

describe('OpenRouterEmbeddingProvider resilience', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCircuitBreakers();
  });

  it('aborts embedding requests that exceed hard timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          });
        });
      }),
    );

    const provider = new OpenRouterEmbeddingProvider({
      apiKey: 'test-key',
      model: 'test-model-timeout',
      dimensions: 8,
      softDeadlineMs: 20,
      hardTimeoutMs: 20,
      maxRetries: 0,
    });

    await expect(provider.embed(['tela tapiceria'])).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('sends latency routing and OpenRouter cache header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-OpenRouter-Cache']).toBe('true');
      const body = JSON.parse(String(init?.body)) as {
        provider: { sort: string; allow_fallbacks: boolean };
      };
      expect(body.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenRouterEmbeddingProvider({
      apiKey: 'test-key',
      model: 'test-model-routing',
      dimensions: 3,
      hardTimeoutMs: 500,
      maxRetries: 0,
    });

    await expect(provider.embed(['lino'])).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('opens circuit after consecutive failures and skips remote calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('provider down');
      }),
    );

    const provider = new OpenRouterEmbeddingProvider({
      apiKey: 'test-key',
      model: 'test-model-circuit',
      dimensions: 3,
      hardTimeoutMs: 100,
      maxRetries: 0,
      circuitFailureThreshold: 2,
      circuitRecoveryMs: 60_000,
    });

    await expect(provider.embed(['a'])).rejects.toThrow(/provider down|Embedding/);
    await expect(provider.embed(['b'])).rejects.toThrow(/provider down|Embedding/);
    await expect(provider.embed(['c'])).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

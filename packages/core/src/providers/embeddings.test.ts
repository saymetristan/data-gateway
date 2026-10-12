import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCircuitBreakers } from './circuit-breaker.js';
import { OpenRouterEmbeddingProvider } from './embeddings.js';

const success = (extra: Record<string, unknown> = {}) => new Response(
  JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], ...extra }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);
const options = { apiKey: 'test-key', model: 'test-model', dimensions: 3, maxRetries: 0 };

describe('OpenRouterEmbeddingProvider resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it('honors Retry-After before retrying a throttled request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterEmbeddingProvider({
      apiKey: 'test-key',
      model: 'test-model-retry-after',
      dimensions: 3,
      hardTimeoutMs: 5_000,
      maxRetries: 1,
    });

    const result = provider.embed(['lino']);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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

  it('does not truncate Retry-After to fit the request budget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '10' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterEmbeddingProvider({
      apiKey: 'test-key', model: 'retry-budget', dimensions: 3,
      hardTimeoutMs: 500, maxRetries: 1,
    });
    const result = provider.embed(['lino']);
    const rejected = expect(result).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels discarded HTTP response bodies before stopping', async () => {
    const response = new Response('private error contents', { status: 429, headers: { 'Retry-After': '10' } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(new OpenRouterEmbeddingProvider({ ...options, maxRetries: 1, hardTimeoutMs: 500 })
      .embed(['lino'])).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['seconds fit', '1', 2_000, true],
    ['date fit', 'Mon, 12 Oct 2026 12:00:01 GMT', 2_000, true],
    ['date does not fit', 'Mon, 12 Oct 2026 12:00:10 GMT', 500, false],
    ['seconds do not fit', '10', 500, false],
  ])('honors Retry-After %s', async (_name, retryAfter, hardTimeoutMs, fits) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('private user input', { status: 503, headers: { 'Retry-After': retryAfter } }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterEmbeddingProvider({ ...options, hardTimeoutMs, maxRetries: 1 });
    const result = provider.embedWithMeta(['lino']);
    if (fits) {
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ meta: { attempts: 2 } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toMatchObject({
        message: 'OpenRouter embeddings failed (503)', code: 'PROVIDER_ERROR',
        meta: { attempts: 1, timedOut: false },
      });
      await vi.advanceTimersByTimeAsync(hardTimeoutMs);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('uses configured ordered routing with fallbacks and safe provider metadata', async () => {
    const order = ['provider-a', 'provider-b'];
    const fetchMock = vi.fn().mockResolvedValue(success({ provider: 'Provider A', id: 'gen-123' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterEmbeddingProvider({ ...options, providerOrder: order });
    order.push('mutated');
    const result = await provider.embedWithMeta(['lino']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).provider)
      .toEqual({ order: ['provider-a', 'provider-b'], allow_fallbacks: true });
    expect(result.meta).toMatchObject({ providerRouting: 'ordered', providerOrder: ['provider-a', 'provider-b'],
      effectiveProvider: 'Provider A', providerRequestId: 'gen-123' });
  });

  it('keeps latency routing when the optional order is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(success());
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenRouterEmbeddingProvider({ ...options, providerOrder: [] }).embedWithMeta(['lino']);
    expect(result.meta.providerRouting).toBe('latency');
    expect(result.meta.providerOrder).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).provider.sort).toBe('latency');
  });

  it.each([
    { provider: { name: 'Provider' }, id: ['gen-1'] },
    { provider: 'Provider\nsecret', id: 'x'.repeat(129) },
    { provider: '', id: '<script>private</script>' },
  ])('omits unsafe provider identifiers %j', async (identifiers) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success(identifiers)));
    const result = await new OpenRouterEmbeddingProvider(options).embedWithMeta(['lino']);
    expect(result.meta.effectiveProvider).toBeUndefined();
    expect(result.meta.providerRequestId).toBeUndefined();
  });

  it.each([
    { data: [] }, { data: [null] }, { data: [{ embedding: [1, 2] }] }, { data: [{ embedding: [1, 2, null] }] },
    { data: [{ embedding: [1, 2, 'secret'] }] },
    { data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2, 3] }] },
  ])('records invalid vectors as failures rather than closing the circuit: %j', async ({ data }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({ data })));
    const provider = new OpenRouterEmbeddingProvider({ ...options, circuitFailureThreshold: 1 });
    await expect(provider.embed(['lino'])).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(provider.circuitSnapshot().state).toBe('open');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite vector values: %s', async (value) => {
    const response = success();
    vi.spyOn(response, 'json').mockResolvedValue({ data: [{ embedding: [1, 2, value] }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(new OpenRouterEmbeddingProvider(options).embed(['lino'])).rejects.toMatchObject({
      code: 'PROVIDER_ERROR', message: 'OpenRouter embeddings returned invalid vectors',
    });
  });

  it('does not expose malformed response contents in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private input is not JSON', { status: 200 })));
    await expect(new OpenRouterEmbeddingProvider(options).embed(['lino'])).rejects.toMatchObject({
      code: 'PROVIDER_ERROR', message: 'OpenRouter embeddings returned invalid JSON',
    });
  });

  it('rejects a null JSON response with a safe provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })));
    await expect(new OpenRouterEmbeddingProvider(options).embed(['lino'])).rejects.toMatchObject({
      code: 'PROVIDER_ERROR', message: 'OpenRouter embeddings returned invalid vectors',
    });
  });

  it.each(['AbortError', 'TimeoutError'])('preserves %s while reading response body', async (name) => {
    const response = success();
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('private body detail', name));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(new OpenRouterEmbeddingProvider(options).embed(['lino'])).rejects.toMatchObject({
      code: 'TIMEOUT', message: 'Embedding request timed out', meta: { timedOut: true },
    });
  });

  it('returns sanitized metadata on invalid-vector failure without exposing response content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({ data: [], provider: 'Provider A', id: 'gen-1' })));
    await expect(new OpenRouterEmbeddingProvider(options).embedWithMeta(['private input'])).rejects.toMatchObject({
      message: 'OpenRouter embeddings returned invalid vectors',
      meta: { effectiveProvider: 'Provider A', providerRequestId: 'gen-1' },
    });
  });

  it.each([
    { apiKey: 'another-key' }, { baseUrl: 'https://other.test/api' }, { providerOrder: ['provider-a'] },
    { hardTimeoutMs: 900 }, { softDeadlineMs: 200 }, { maxRetries: 1 },
    { circuitFailureThreshold: 2 }, { circuitRecoveryMs: 20 }, { dimensions: 4 },
  ])('isolates circuit state by endpoint, credential, routing and configuration: %j', async (change) => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('provider down'));
    vi.stubGlobal('fetch', fetchMock);
    const first = new OpenRouterEmbeddingProvider({ ...options, circuitFailureThreshold: 1 });
    await expect(first.embed(['lino'])).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const second = new OpenRouterEmbeddingProvider({ ...options, circuitFailureThreshold: 1, ...change });
    expect(second.circuitSnapshot().state).toBe('closed');
    expect(new OpenRouterEmbeddingProvider({ ...options, circuitFailureThreshold: 1 }).circuitSnapshot().state).toBe('open');
  });

  it('allows only one concurrent recovery probe and ignores late closed-generation responses', async () => {
    vi.useFakeTimers();
    let resolveOld!: (response: Response) => void;
    let resolveProbe!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockRejectedValueOnce(new Error('provider down'))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveProbe = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenRouterEmbeddingProvider({ ...options, circuitFailureThreshold: 1, circuitRecoveryMs: 10 });
    const old = provider.embed(['old']);
    await expect(provider.embed(['failing'])).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await vi.advanceTimersByTimeAsync(10);
    const probe = provider.embed(['probe']);
    await expect(provider.embed(['concurrent'])).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    resolveOld(success());
    await old;
    expect(provider.circuitSnapshot().state).toBe('half-open');
    await expect(provider.embed(['still concurrent'])).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    resolveProbe(success());
    await probe;
    expect(provider.circuitSnapshot().state).toBe('closed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

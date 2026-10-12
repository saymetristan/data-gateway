import { createHash } from 'node:crypto';
import {
  CircuitBreaker,
  getCircuitBreaker,
  type CircuitSnapshot,
  type CircuitState,
} from './circuit-breaker.js';

export const DEFAULT_EMBEDDING_SOFT_DEADLINE_MS = 2_500;
export const DEFAULT_EMBEDDING_HARD_TIMEOUT_MS = 4_000;
export const DEFAULT_EMBEDDING_MAX_RETRIES = 1;
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_RECOVERY_MS = 30_000;

export type EmbeddingAttemptMeta = {
  attempts: number;
  circuitState: CircuitState;
  cacheHeaderEnabled: boolean;
  providerRouting: 'latency' | 'ordered';
  providerOrder?: string[];
  effectiveProvider?: string;
  providerRequestId?: string;
  timedOut: boolean;
  skippedByCircuit: boolean;
};

export type EmbedResult = {
  vectors: number[][];
  meta: EmbeddingAttemptMeta;
};

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  /** Optional richer API used by query path for observability. */
  embedWithMeta?(texts: string[]): Promise<EmbedResult>;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'mock-embedding';
  readonly dimensions: number;
  private readonly delayMs: number;

  constructor(dimensions = 1024, options?: { delayMs?: number }) {
    this.dimensions = dimensions;
    this.delayMs = options?.delayMs ?? 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await this.embedWithMeta(texts);
    return result.vectors;
  }

  async embedWithMeta(texts: string[]): Promise<EmbedResult> {
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }
    return {
      vectors: texts.map((text, index) => {
        const vector = new Array<number>(this.dimensions).fill(0);
        for (let i = 0; i < this.dimensions; i++) {
          vector[i] = ((text.charCodeAt(i % text.length) + index) % 97) / 97;
        }
        return vector;
      }),
      meta: {
        attempts: 1,
        circuitState: 'closed',
        cacheHeaderEnabled: false,
        providerRouting: 'latency',
        timedOut: false,
        skippedByCircuit: false,
      },
    };
  }
}

type OpenRouterEmbeddingResponse = {
  provider?: unknown;
  id?: unknown;
};

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly softDeadlineMs: number;
  private readonly hardTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly providerOrder: string[] | undefined;
  private readonly circuit: CircuitBreaker;

  constructor(options: {
    apiKey: string;
    model: string;
    dimensions: number;
    baseUrl?: string;
    softDeadlineMs?: number;
    hardTimeoutMs?: number;
    maxRetries?: number;
    circuitFailureThreshold?: number;
    circuitRecoveryMs?: number;
    providerOrder?: string[];
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.softDeadlineMs = options.softDeadlineMs ?? DEFAULT_EMBEDDING_SOFT_DEADLINE_MS;
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_EMBEDDING_HARD_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_EMBEDDING_MAX_RETRIES;
    this.providerOrder = options.providerOrder?.length ? [...options.providerOrder] : undefined;
    const circuitOptions = {
      failureThreshold: options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      recoveryMs: options.circuitRecoveryMs ?? DEFAULT_CIRCUIT_RECOVERY_MS,
    };
    const key = createHash('sha256').update(JSON.stringify({
      baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, dimensions: this.dimensions,
      providerOrder: this.providerOrder, softDeadlineMs: this.softDeadlineMs,
      hardTimeoutMs: this.hardTimeoutMs, maxRetries: this.maxRetries, ...circuitOptions,
    })).digest('hex');
    this.circuit = getCircuitBreaker(`embeddings:${key}`, circuitOptions);
  }

  get softDeadline(): number {
    return this.softDeadlineMs;
  }

  get hardTimeout(): number {
    return this.hardTimeoutMs;
  }

  circuitSnapshot(): CircuitSnapshot {
    return this.circuit.snapshot();
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await this.embedWithMeta(texts);
    return result.vectors;
  }

  async embedWithMeta(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        meta: {
          attempts: 0,
          circuitState: this.circuit.snapshot().state,
          cacheHeaderEnabled: true,
          ...this.routingMeta(),
          timedOut: false,
          skippedByCircuit: false,
        },
      };
    }

    const started = Date.now();
    const snapshot = this.circuit.snapshot(started);
    const attempt = this.circuit.acquireRequest(started);
    if (!attempt) {
      throw Object.assign(new Error('Embedding circuit open; skipping remote call'), {
        code: 'CIRCUIT_OPEN',
        meta: {
          attempts: 0,
          circuitState: snapshot.state,
          cacheHeaderEnabled: true,
          ...this.routingMeta(),
          timedOut: false,
          skippedByCircuit: true,
        } satisfies EmbeddingAttemptMeta,
      });
    }

    const budgetMs = this.hardTimeoutMs;
    let attempts = 0;
    let lastError: unknown;
    let timedOut = false;
    let effectiveProvider: string | undefined;
    let providerRequestId: string | undefined;

    while (attempts <= this.maxRetries) {
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 0) {
        timedOut = true;
        break;
      }

      attempts += 1;
      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-OpenRouter-Cache': 'true',
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            dimensions: this.dimensions,
            provider: {
              ...(this.providerOrder ? { order: this.providerOrder } : { sort: 'latency' }),
              allow_fallbacks: true,
            },
          }),
          signal: AbortSignal.timeout(remaining),
        });

        timedOut = false;
        if (!response.ok) {
          lastError = new Error(`OpenRouter embeddings failed (${String(response.status)})`);
          await response.body?.cancel().catch(() => undefined);
          if (![429, 502, 503, 504].includes(response.status) || attempts > this.maxRetries) break;
          const retryRemaining = budgetMs - (Date.now() - started);
          const delayMs = retryDelayMs(response.headers.get('Retry-After'), attempts);
          if (delayMs + 50 >= retryRemaining) break;
          await sleep(delayMs);
          continue;
        }

        const json: unknown = await response.json().catch((error: unknown) => {
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new DOMException('Embedding response body timed out', 'TimeoutError');
          }
          throw new Error('OpenRouter embeddings returned invalid JSON');
        });
        const identifiers = typeof json === 'object' && json !== null
          ? json as OpenRouterEmbeddingResponse : undefined;
        effectiveProvider = safeIdentifier(identifiers?.provider);
        providerRequestId = safeIdentifier(identifiers?.id);
        const vectors = validateVectors(json, texts.length, this.dimensions);
        this.circuit.recordSuccess(Date.now(), attempt);
        return {
          vectors,
          meta: {
            attempts,
            circuitState: this.circuit.snapshot().state,
            cacheHeaderEnabled: true,
            ...this.routingMeta(),
            ...(effectiveProvider ? { effectiveProvider } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
            timedOut: false,
            skippedByCircuit: false,
          },
        };
      } catch (error) {
        lastError = error;
        timedOut = isTimeoutError(error);
        const canRetry =
          attempts <= this.maxRetries &&
          budgetMs - (Date.now() - started) > 50 &&
          (timedOut || isTransientError(error));
        if (!canRetry) break;
        if (budgetMs - (Date.now() - started) <= 200) break;
        await sleep(150);
      }
    }

    this.circuit.recordFailure(Date.now(), attempt);
    const meta: EmbeddingAttemptMeta = {
      attempts,
      circuitState: this.circuit.snapshot().state,
      cacheHeaderEnabled: true,
      ...this.routingMeta(),
      ...(effectiveProvider ? { effectiveProvider } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      timedOut,
      skippedByCircuit: false,
    };
    const message = timedOut
      ? 'Embedding request timed out'
      : lastError instanceof Error
        ? lastError.message
        : 'Embedding request failed';
    throw Object.assign(new Error(message), {
      code: timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR',
      meta,
    });
  }

  private routingMeta(): Pick<EmbeddingAttemptMeta, 'providerRouting' | 'providerOrder'> {
    return this.providerOrder
      ? { providerRouting: 'ordered', providerOrder: [...this.providerOrder] }
      : { providerRouting: 'latency' };
  }
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]*$/.test(value) ? value : undefined;
}

function validateVectors(json: unknown, count: number, dimensions: number): number[][] {
  if (typeof json !== 'object' || json === null || !('data' in json) || !Array.isArray(json.data)) {
    throw new Error('OpenRouter embeddings returned invalid vectors');
  }
  const data: unknown[] = json.data;
  if (data.length !== count || data.some((item) =>
    typeof item !== 'object' || item === null || !('embedding' in item) ||
    !Array.isArray(item.embedding) || item.embedding.length !== dimensions ||
    item.embedding.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new Error('OpenRouter embeddings returned invalid vectors');
  }
  return data.map((item) => (item as { embedding: number[] }).embedding);
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }
  const exponentialMs = 500 * 2 ** Math.max(0, attempt - 1);
  return exponentialMs + Math.floor(Math.random() * 250);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    /aborted|timeout/i.test(error.message)
  );
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /429|502|503|504|ECONNRESET|ETIMEDOUT|fetch failed/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

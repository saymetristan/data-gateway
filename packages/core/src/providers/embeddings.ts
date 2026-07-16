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
  providerRouting: 'latency';
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
  data: Array<{ embedding: number[] }>;
};

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly softDeadlineMs: number;
  private readonly hardTimeoutMs: number;
  private readonly maxRetries: number;
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
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.softDeadlineMs = options.softDeadlineMs ?? DEFAULT_EMBEDDING_SOFT_DEADLINE_MS;
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_EMBEDDING_HARD_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_EMBEDDING_MAX_RETRIES;
    this.circuit = getCircuitBreaker(`embeddings:${this.model}`, {
      failureThreshold: options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      recoveryMs: options.circuitRecoveryMs ?? DEFAULT_CIRCUIT_RECOVERY_MS,
    });
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
          providerRouting: 'latency',
          timedOut: false,
          skippedByCircuit: false,
        },
      };
    }

    const started = Date.now();
    const snapshot = this.circuit.snapshot(started);
    if (!this.circuit.canRequest(started)) {
      throw Object.assign(new Error('Embedding circuit open; skipping remote call'), {
        code: 'CIRCUIT_OPEN',
        meta: {
          attempts: 0,
          circuitState: snapshot.state,
          cacheHeaderEnabled: true,
          providerRouting: 'latency' as const,
          timedOut: false,
          skippedByCircuit: true,
        } satisfies EmbeddingAttemptMeta,
      });
    }

    const budgetMs = this.hardTimeoutMs;
    let attempts = 0;
    let lastError: unknown;
    let timedOut = false;

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
              sort: 'latency',
              allow_fallbacks: true,
            },
          }),
          signal: AbortSignal.timeout(remaining),
        });

        if (response.status === 429 && attempts <= this.maxRetries) {
          const retryRemaining = budgetMs - (Date.now() - started);
          if (retryRemaining <= 50) {
            timedOut = true;
            break;
          }
          await sleep(Math.min(200, retryRemaining));
          continue;
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenRouter embeddings failed (${String(response.status)}): ${body}`);
        }

        const json = (await response.json()) as OpenRouterEmbeddingResponse;
        this.circuit.recordSuccess();
        return {
          vectors: json.data.map((item) => item.embedding),
          meta: {
            attempts,
            circuitState: this.circuit.snapshot().state,
            cacheHeaderEnabled: true,
            providerRouting: 'latency',
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
        await sleep(Math.min(150, budgetMs - (Date.now() - started)));
      }
    }

    this.circuit.recordFailure();
    const meta: EmbeddingAttemptMeta = {
      attempts,
      circuitState: this.circuit.snapshot().state,
      cacheHeaderEnabled: true,
      providerRouting: 'latency',
      timedOut,
      skippedByCircuit: false,
    };
    const message = timedOut
      ? 'Embedding request timed out'
      : lastError instanceof Error
        ? lastError.message
        : 'Embedding request failed';
    throw Object.assign(new Error(message), { code: timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR', meta });
  }
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

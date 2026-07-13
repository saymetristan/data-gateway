export type CircuitState = 'closed' | 'open' | 'half-open';

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  recoveryMs?: number;
  halfOpenSuccesses?: number;
};

export type CircuitSnapshot = {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
};

/**
 * In-memory circuit breaker keyed by resource (e.g. embedding model).
 * Failures trip the circuit; after recoveryMs a single probe is allowed (half-open).
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly recoveryMs: number;
  private readonly halfOpenSuccesses: number;
  private failures = 0;
  private successesInHalfOpen = 0;
  private openedAt: number | null = null;
  private state: CircuitState = 'closed';

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryMs = options.recoveryMs ?? 30_000;
    this.halfOpenSuccesses = options.halfOpenSuccesses ?? 1;
  }

  snapshot(now = Date.now()): CircuitSnapshot {
    this.maybeTransition(now);
    return {
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt,
    };
  }

  canRequest(now = Date.now()): boolean {
    this.maybeTransition(now);
    return this.state !== 'open';
  }

  recordSuccess(now = Date.now()): void {
    this.maybeTransition(now);
    if (this.state === 'half-open') {
      this.successesInHalfOpen += 1;
      if (this.successesInHalfOpen >= this.halfOpenSuccesses) {
        this.reset();
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(now = Date.now()): void {
    this.maybeTransition(now);
    if (this.state === 'half-open') {
      this.trip(now);
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip(now);
    }
  }

  private maybeTransition(now: number): void {
    if (this.state === 'open' && this.openedAt !== null && now - this.openedAt >= this.recoveryMs) {
      this.state = 'half-open';
      this.successesInHalfOpen = 0;
    }
  }

  private trip(now: number): void {
    this.state = 'open';
    this.openedAt = now;
    this.successesInHalfOpen = 0;
  }

  private reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = null;
    this.successesInHalfOpen = 0;
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(
  key: string,
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  const existing = breakers.get(key);
  if (existing) return existing;
  const created = new CircuitBreaker(options);
  breakers.set(key, created);
  return created;
}

/** Test helper — clears shared breaker registry. */
export function resetCircuitBreakers(): void {
  breakers.clear();
}

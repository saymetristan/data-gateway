export type CircuitState = 'closed' | 'open' | 'half-open';

/** Opaque lease for one logical request; completions from old generations are ignored. */
export type CircuitAttempt = Readonly<{ generation: number }>;

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
  private generation = 0;
  private readonly attempts = new Set<CircuitAttempt>();
  private probe: CircuitAttempt | null = null;
  private legacyProbe: CircuitAttempt | null = null;

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
    if (this.state === 'closed') return true;
    const attempt = this.acquireRequest(now);
    if (!attempt) return false;
    this.legacyProbe = attempt;
    return true;
  }

  acquireRequest(now = Date.now()): CircuitAttempt | null {
    this.maybeTransition(now);
    if (this.state === 'open' || (this.state === 'half-open' && this.probe)) return null;
    const attempt = Object.freeze({ generation: this.generation });
    this.attempts.add(attempt);
    if (this.state === 'half-open') this.probe = attempt;
    return attempt;
  }

  recordSuccess(now = Date.now(), attempt?: CircuitAttempt): void {
    // Preserve the timestamp argument for legacy callers; only admission advances recovery.
    void now;
    if (!this.complete(attempt)) return;
    if (this.state === 'half-open') {
      this.successesInHalfOpen += 1;
      if (this.successesInHalfOpen >= this.halfOpenSuccesses) {
        this.reset();
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(now = Date.now(), attempt?: CircuitAttempt): void {
    if (!this.complete(attempt)) return;
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
      this.invalidateAttempts();
    }
  }

  private trip(now: number): void {
    this.state = 'open';
    this.openedAt = now;
    this.successesInHalfOpen = 0;
    this.invalidateAttempts();
  }

  private reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = null;
    this.successesInHalfOpen = 0;
    this.invalidateAttempts();
  }

  private complete(attempt?: CircuitAttempt): boolean {
    const lease = attempt ?? this.legacyProbe ?? undefined;
    if (!lease) return this.state === 'closed';
    if (lease.generation !== this.generation || !this.attempts.delete(lease)) return false;
    if (this.probe === lease) this.probe = null;
    if (this.legacyProbe === lease) this.legacyProbe = null;
    return true;
  }

  private invalidateAttempts(): void {
    this.generation += 1;
    this.attempts.clear();
    this.probe = null;
    this.legacyProbe = null;
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

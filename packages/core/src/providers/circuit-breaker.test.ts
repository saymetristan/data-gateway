import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker probes', () => {
  it('allows only one half-open request', () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, recoveryMs: 10 });
    circuit.recordFailure(0);
    expect(circuit.canRequest(10)).toBe(true);
    expect(circuit.canRequest(10)).toBe(false);
    circuit.recordSuccess(11);
    expect(circuit.snapshot(11).state).toBe('closed');
  });

  it('ignores stale success and failure across circuit generations', () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, recoveryMs: 10 });
    const oldSuccess = circuit.acquireRequest(0)!;
    const oldFailure = circuit.acquireRequest(0)!;
    const failing = circuit.acquireRequest(0)!;
    circuit.recordFailure(0, failing);
    circuit.recordSuccess(1, oldSuccess);
    expect(circuit.snapshot(1).state).toBe('open');
    const probe = circuit.acquireRequest(10)!;
    expect(circuit.acquireRequest(10)).toBeNull();
    expect(circuit.canRequest(10)).toBe(false);
    circuit.recordFailure(11, oldFailure);
    expect(circuit.snapshot(11).state).toBe('half-open');
    circuit.recordSuccess(12, probe);
    circuit.recordFailure(13, oldFailure);
    expect(circuit.snapshot(13)).toEqual({ state: 'closed', failures: 0, openedAt: null });
  });

  it('rejects repeated or foreign completions and requires sequential recovery probes', () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, recoveryMs: 10, halfOpenSuccesses: 2 });
    circuit.recordFailure(0);
    const first = circuit.acquireRequest(10)!;
    circuit.recordSuccess(11, { generation: first.generation });
    expect(circuit.acquireRequest(11)).toBeNull();
    circuit.recordSuccess(11, first);
    circuit.recordSuccess(11, first);
    expect(circuit.snapshot(11).state).toBe('half-open');
    const second = circuit.acquireRequest(12)!;
    circuit.recordSuccess(13, second);
    expect(circuit.snapshot(13).state).toBe('closed');
  });

  it('reopens on a failed probe and ignores its late duplicate success', () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, recoveryMs: 10 });
    circuit.recordFailure(0);
    const probe = circuit.acquireRequest(10)!;
    circuit.recordFailure(11, probe);
    circuit.recordSuccess(12, probe);
    expect(circuit.snapshot(12).state).toBe('open');
    expect(circuit.acquireRequest(20)).toBeNull();
    expect(circuit.acquireRequest(21)).not.toBeNull();
  });

  it('does not let tokenless completions release a leased half-open probe', () => {
    const circuit = new CircuitBreaker({ failureThreshold: 1, recoveryMs: 10 });
    circuit.recordFailure(0);
    const probe = circuit.acquireRequest(10)!;
    circuit.recordSuccess(11);
    circuit.recordFailure(11);
    expect(circuit.acquireRequest(11)).toBeNull();
    circuit.recordSuccess(12, probe);
    expect(circuit.snapshot(12).state).toBe('closed');
  });
});

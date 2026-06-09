import { describe, it, expect } from 'vitest';
import { isTransitionAllowed } from './maturity.js';

describe('maturity transitions', () => {
  it('permite transiciones válidas del pipeline', () => {
    expect(isTransitionAllowed('connected', 'profiled')).toBe(true);
    expect(isTransitionAllowed('connected', 'mapped')).toBe(true);
    expect(isTransitionAllowed('profiled', 'mapped')).toBe(true);
    expect(isTransitionAllowed('mapped', 'indexed')).toBe(true);
    expect(isTransitionAllowed('indexed', 'validated')).toBe(true);
    expect(isTransitionAllowed('validated', 'agent_ready')).toBe(true);
  });

  it('permite invalidación por re-index o mapping nuevo', () => {
    expect(isTransitionAllowed('validated', 'indexed')).toBe(true);
    expect(isTransitionAllowed('agent_ready', 'indexed')).toBe(true);
    expect(isTransitionAllowed('validated', 'mapped')).toBe(true);
  });

  it('rechaza saltos inválidos', () => {
    expect(isTransitionAllowed('connected', 'indexed')).toBe(false);
    expect(isTransitionAllowed('connected', 'agent_ready')).toBe(false);
    expect(isTransitionAllowed('mapped', 'validated')).toBe(false);
  });
});

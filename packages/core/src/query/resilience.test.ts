import { describe, expect, it, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  resetCircuitBreakers,
} from '../providers/circuit-breaker.js';
import {
  QueryEmbeddingCache,
  buildQueryEmbeddingCacheHash,
  normalizeQueryForEmbeddingCache,
  resetSharedQueryEmbeddingCache,
} from '../services/query-embedding-cache.js';
import { expandQueryWithSynonyms } from '../query/synonyms.js';
import { reciprocalRankFusion, RRF_K } from '../query/rrf.js';

describe('normalizeQueryForEmbeddingCache', () => {
  it('normalizes case, accents and whitespace', () => {
    expect(normalizeQueryForEmbeddingCache('  ViníPiel   Tapicería ')).toBe('vinipiel tapiceria');
  });

  it('builds stable hashes for equivalent queries', () => {
    const a = buildQueryEmbeddingCacheHash({
      model: 'm',
      dimensions: 1024,
      query: 'Vinipiel  Tapicería',
    });
    const b = buildQueryEmbeddingCacheHash({
      model: 'm',
      dimensions: 1024,
      query: 'vinipiel tapiceria',
    });
    expect(a).toBe(b);
  });
});

describe('QueryEmbeddingCache L1', () => {
  beforeEach(() => {
    resetSharedQueryEmbeddingCache();
  });

  it('stores and retrieves L1 entries with LRU eviction', () => {
    const cache = new QueryEmbeddingCache({ l1MaxEntries: 2, ttlMs: 60_000 });
    cache.setL1('ws', 'h1', 'model', 4, [1, 0, 0, 0]);
    cache.setL1('ws', 'h2', 'model', 4, [0, 1, 0, 0]);
    cache.setL1('ws', 'h3', 'model', 4, [0, 0, 1, 0]);

    expect(cache.getFromL1('ws', 'h1', 'model', 4)).toBeNull();
    expect(cache.getFromL1('ws', 'h2', 'model', 4)).toEqual([0, 1, 0, 0]);
    expect(cache.getFromL1('ws', 'h3', 'model', 4)).toEqual([0, 0, 1, 0]);
  });

  it('deduplicates concurrent resolveOrLoad calls', async () => {
    const cache = new QueryEmbeddingCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [1, 2, 3];
    };

    const [a, b] = await Promise.all([
      cache.resolveOrLoad('k', loader),
      cache.resolveOrLoad('k', loader),
    ]);

    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
  });
});

describe('CircuitBreaker', () => {
  beforeEach(() => {
    resetCircuitBreakers();
  });

  it('trips after threshold and recovers to half-open', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryMs: 50 });
    const t0 = 1_000;
    breaker.recordFailure(t0);
    expect(breaker.canRequest(t0)).toBe(true);
    breaker.recordFailure(t0 + 1);
    expect(breaker.canRequest(t0 + 2)).toBe(false);
    expect(breaker.snapshot(t0 + 2).state).toBe('open');
    expect(breaker.snapshot(t0 + 60).state).toBe('half-open');
    expect(breaker.canRequest(t0 + 60)).toBe(true);
    breaker.recordSuccess(t0 + 61);
    expect(breaker.snapshot(t0 + 62).state).toBe('closed');
  });
});

describe('expandQueryWithSynonyms', () => {
  const dictionary = {
    vinipiel: ['piel sintetica', 'tapiceria'],
    retapizar: ['tapiceria'],
  };

  it('adds mapping synonyms without duplicating existing terms', () => {
    const result = expandQueryWithSynonyms('vinipiel para retapizar', dictionary);
    expect(result.addedTerms).toContain('piel sintetica');
    expect(result.addedTerms).toContain('tapiceria');
    expect(result.expanded).toContain('vinipiel para retapizar');
  });

  it('is a no-op when dictionary is empty or no terms match', () => {
    expect(expandQueryWithSynonyms('algodón orgánico', dictionary).addedTerms).toEqual([]);
    expect(expandQueryWithSynonyms('vinipiel', {}).addedTerms).toEqual([]);
  });
});

describe('weighted reciprocalRankFusion', () => {
  it('keeps unweighted behaviour for string[][] inputs', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(fused[0]?.id).toBe('a');
  });

  it('applies weights to ranking contributions', () => {
    const fused = reciprocalRankFusion([
      { ids: ['lex'], weight: 1 },
      { ids: ['vec'], weight: 10 },
    ]);
    expect(fused[0]?.id).toBe('vec');
    expect(fused[0]?.score).toBeCloseTo(10 / (RRF_K + 1), 6);
  });
});

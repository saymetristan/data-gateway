import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  isWeakSearchConfidence,
  WEAK_SEARCH_CONFIDENCE_THRESHOLD,
} from './confidence.js';

describe('computeConfidence', () => {
  it('devuelve valor alto con gap amplio, lexical match y cobertura distintiva', () => {
    const value = computeConfidence({
      rankedScores: [1, 0.2],
      requestedFilterCount: 2,
      appliedFilterCount: 2,
      topLexicalMatch: true,
      resultsCount: 10,
      limit: 10,
      distinctiveTermCoverage: 1,
    });
    expect(value).toBeGreaterThan(0.8);
  });

  it('devuelve valor bajo sin resultados ni match lexical', () => {
    const value = computeConfidence({
      rankedScores: [],
      requestedFilterCount: 3,
      appliedFilterCount: 0,
      topLexicalMatch: false,
      resultsCount: 0,
      limit: 10,
      distinctiveTermCoverage: 0,
    });
    expect(value).toBeLessThan(0.3);
  });

  it('trata cobertura de filtros como 1 cuando no hay filtros pedidos', () => {
    const value = computeConfidence({
      rankedScores: [0.5, 0.4],
      requestedFilterCount: 0,
      appliedFilterCount: 0,
      topLexicalMatch: false,
      resultsCount: 2,
      limit: 10,
      distinctiveTermCoverage: 0,
    });
    expect(value).toBeGreaterThan(0.2);
  });

  it('acota a [0,1]', () => {
    const value = computeConfidence({
      rankedScores: [100, 0],
      requestedFilterCount: 10,
      appliedFilterCount: 10,
      topLexicalMatch: true,
      resultsCount: 50,
      limit: 10,
      distinctiveTermCoverage: 1,
    });
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('cap vector-only weak neighbors without distinctive coverage', () => {
    const value = computeConfidence({
      rankedScores: [0.018, 0.017],
      requestedFilterCount: 0,
      appliedFilterCount: 0,
      topLexicalMatch: false,
      resultsCount: 12,
      limit: 12,
      distinctiveTermCoverage: 0,
      vectorOnlyFallback: true,
    });
    expect(value).toBeLessThanOrEqual(0.42);
    expect(isWeakSearchConfidence(value)).toBe(true);
  });

  it('keeps higher confidence when distinctive terms match top hit', () => {
    const value = computeConfidence({
      rankedScores: [0.03, 0.02],
      requestedFilterCount: 0,
      appliedFilterCount: 0,
      topLexicalMatch: true,
      resultsCount: 6,
      limit: 10,
      distinctiveTermCoverage: 1,
      vectorOnlyFallback: false,
    });
    expect(value).toBeGreaterThan(WEAK_SEARCH_CONFIDENCE_THRESHOLD);
  });
});

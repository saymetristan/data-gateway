import { describe, it, expect } from 'vitest';
import {
  aggregateEvalMetrics,
  evaluateCase,
  filterMatches,
  precisionAtK,
} from './metrics.js';

describe('eval metrics', () => {
  it('calcula precision@k con matches parciales', () => {
    expect(precisionAtK(['42', '43'], ['42', '99', '43'], 10)).toBe(1);
    expect(precisionAtK(['42', '43'], ['99', '98'], 10)).toBe(0);
    expect(precisionAtK([], ['42'], 10)).toBe(1);
  });

  it('falla cuando faltan filtros requeridos', () => {
    const result = evaluateCase(
      {
        caseId: 'c1',
        query: 'test',
        resultExternalIds: ['1'],
        appliedFilters: [{ field: 'price', op: 'lt', value: 100 }],
        resultData: [{ sku: 'A' }],
        latencyMs: 10,
        limit: 10,
      },
      {
        mustApplyFilters: [
          { field: 'price', op: 'lt', value: 100 },
          { field: 'color', op: 'eq', value: 'rojo' },
        ],
      },
    );

    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('color'))).toBe(true);
  });

  it('compara valores de filtros con la misma semántica del runner', () => {
    expect(
      filterMatches(
        { field: 'price', op: 'between', value: [10, 20] },
        [{ field: 'price', op: 'between', value: [10, 20] }],
      ),
    ).toBe(true);
    expect(
      filterMatches(
        { field: 'price', op: 'between', value: [10, 20] },
        [{ field: 'price', op: 'between', value: [20, 10] }],
      ),
    ).toBe(false);
  });

  it('agrega métricas globales', () => {
    const metrics = aggregateEvalMetrics({
      caseResults: [
        { passed: true, precision: 1, filterScore: 1, latencyMs: 100 },
        { passed: false, precision: 0, filterScore: 0.5, latencyMs: 200 },
      ],
      sensitiveLeaks: 0,
    });

    expect(metrics.score).toBe(0.5);
    expect(metrics.casesTotal).toBe(2);
    expect(metrics.casesPassed).toBe(1);
    expect(metrics.latencyMsP50).toBe(100);
    expect(metrics.latencyMsP95).toBe(200);
  });
});

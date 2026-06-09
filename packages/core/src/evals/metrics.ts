import type { NormalizedFilter } from '../schemas/query.js';
import type { EvalCaseResult, EvalRunMetrics } from '../schemas/evals.js';

export type EvalCaseAssertions = {
  expectedExternalIds?: string[];
  mustApplyFilters?: NormalizedFilter[];
  mustNotContainFields?: string[];
};

export type EvalCaseExecution = {
  caseId: string;
  query: string;
  resultExternalIds: string[];
  appliedFilters: NormalizedFilter[];
  resultData: Record<string, unknown>[];
  latencyMs: number;
  limit: number;
};

export function evaluateCase(
  execution: EvalCaseExecution,
  assertions: EvalCaseAssertions,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (assertions.expectedExternalIds?.length) {
    const precision = precisionAtK(
      assertions.expectedExternalIds,
      execution.resultExternalIds,
      execution.limit,
    );
    if (precision < 1) {
      reasons.push(
        `precision@k ${precision.toFixed(3)} < 1 (expected ${assertions.expectedExternalIds.join(', ')}, got ${execution.resultExternalIds.join(', ')})`,
      );
    }
  }

  if (assertions.mustApplyFilters?.length) {
    for (const required of assertions.mustApplyFilters) {
      if (!filterMatches(required, execution.appliedFilters)) {
        reasons.push(`missing filter ${required.field} ${required.op} ${String(required.value)}`);
      }
    }
  }

  if (assertions.mustNotContainFields?.length) {
    for (const field of assertions.mustNotContainFields) {
      const leaked = execution.resultData.some((data) => field in data);
      if (leaked) {
        reasons.push(`sensitive field "${field}" leaked in response`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons };
}

export function precisionAtK(
  expectedExternalIds: string[],
  resultExternalIds: string[],
  k: number,
): number {
  if (expectedExternalIds.length === 0) return 1;
  const expected = new Set(expectedExternalIds);
  const topK = resultExternalIds.slice(0, k);
  const hits = topK.filter((id) => expected.has(id)).length;
  return hits / Math.min(k, expectedExternalIds.length);
}

export function filterMatches(
  required: NormalizedFilter,
  applied: NormalizedFilter[],
): boolean {
  return applied.some(
    (filter) =>
      filter.field === required.field &&
      filter.op === required.op &&
      valuesEqual(filter.value, required.value),
  );
}

export function valuesEqual(
  left: NormalizedFilter['value'],
  right: NormalizedFilter['value'],
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

export function countSensitiveLeaks(
  executions: EvalCaseExecution[],
  forbiddenFields: string[][],
): number {
  let leaks = 0;
  for (let i = 0; i < executions.length; i++) {
    const fields = forbiddenFields[i] ?? [];
    for (const field of fields) {
      if (executions[i]?.resultData.some((data) => field in data)) {
        leaks += 1;
      }
    }
  }
  return leaks;
}

export function aggregateEvalMetrics(input: {
  caseResults: Array<{ passed: boolean; precision: number; filterScore: number; latencyMs: number }>;
  sensitiveLeaks: number;
}): EvalRunMetrics {
  const casesTotal = input.caseResults.length;
  const casesPassed = input.caseResults.filter((result) => result.passed).length;
  const latencies = input.caseResults.map((result) => result.latencyMs).sort((a, b) => a - b);

  const precisionAtK =
    casesTotal === 0
      ? 0
      : input.caseResults.reduce((sum, result) => sum + result.precision, 0) / casesTotal;

  const filterAccuracy =
    casesTotal === 0
      ? 0
      : input.caseResults.reduce((sum, result) => sum + result.filterScore, 0) / casesTotal;

  return {
    score: casesTotal === 0 ? 0 : casesPassed / casesTotal,
    casesTotal,
    casesPassed,
    precisionAtK,
    filterAccuracy,
    sensitiveLeaks: input.sensitiveLeaks,
    latencyMsP50: percentile(latencies, 0.5),
    latencyMsP95: percentile(latencies, 0.95),
  };
}

export function toCaseResults(
  executions: EvalCaseExecution[],
  evaluations: Array<{ passed: boolean; reasons: string[] }>,
): { passed: EvalCaseResult[]; failed: EvalCaseResult[] } {
  const passed: EvalCaseResult[] = [];
  const failed: EvalCaseResult[] = [];

  for (let i = 0; i < executions.length; i++) {
    const execution = executions[i];
    const evaluation = evaluations[i];
    if (!execution || !evaluation) continue;

    const item: EvalCaseResult = {
      caseId: execution.caseId,
      query: execution.query,
      ...(evaluation.reasons.length > 0 ? { reasons: evaluation.reasons } : {}),
    };

    if (evaluation.passed) {
      passed.push(item);
    } else {
      failed.push(item);
    }
  }

  return { passed, failed };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

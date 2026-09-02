import { z } from 'zod';
import { normalizedFilterSchema, queryPreferenceSchema } from './query.js';

export const createEvalSetSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  threshold: z.number().min(0).max(1).optional(),
  sourceId: z.string().uuid().optional(),
});

export const mustRankAboveSchema = z.object({
  higher: z.string().min(1),
  lower: z.string().min(1),
});

export const mustNotAppearInTopSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  k: z.number().int().min(1).max(50),
});

export const createEvalCaseSchema = z
  .object({
    query: z.string().min(1),
    expectedExternalIds: z.array(z.string().min(1)).optional(),
    expectedTopIds: z.array(z.string().min(1)).optional(),
    mustRankAbove: z.array(mustRankAboveSchema).optional(),
    mustApplyFilters: z.array(normalizedFilterSchema).optional(),
    mustApplyPreferences: z.array(queryPreferenceSchema).optional(),
    mustNotContainFields: z.array(z.string().min(1)).optional(),
    mustNotAppearInTop: mustNotAppearInTopSchema.optional(),
    maxResultCount: z.number().int().min(0).max(50).optional(),
    maxConfidence: z.number().min(0).max(1).optional(),
    mustContainFields: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (value) =>
      (value.expectedExternalIds?.length ?? 0) > 0 ||
      (value.expectedTopIds?.length ?? 0) > 0 ||
      (value.mustRankAbove?.length ?? 0) > 0 ||
      (value.mustApplyFilters?.length ?? 0) > 0 ||
      (value.mustApplyPreferences?.length ?? 0) > 0 ||
      (value.mustNotContainFields?.length ?? 0) > 0 ||
      value.mustNotAppearInTop !== undefined ||
      value.maxResultCount !== undefined ||
      value.maxConfidence !== undefined ||
      (value.mustContainFields?.length ?? 0) > 0,
    { message: 'At least one assertion is required' },
  );

export const runEvalSetSchema = z.object({
  evalSetId: z.string().uuid(),
});

export const evalRunStatusSchema = z.enum(['running', 'completed', 'failed']);

export const evalRunMetricsSchema = z.object({
  score: z.number().min(0).max(1),
  casesTotal: z.number().int().nonnegative(),
  casesPassed: z.number().int().nonnegative(),
  precisionAtK: z.number().min(0).max(1),
  filterAccuracy: z.number().min(0).max(1),
  sensitiveLeaks: z.number().int().nonnegative(),
  latencyMsP50: z.number().nonnegative(),
  latencyMsP95: z.number().nonnegative(),
});

export const evalCaseResultSchema = z.object({
  caseId: z.string().uuid(),
  query: z.string(),
  reasons: z.array(z.string()).optional(),
});

export const evalRunResponseSchema = z.object({
  id: z.string().uuid(),
  evalSetId: z.string().uuid(),
  retrievalPolicyId: z.string().uuid().nullable().optional(),
  status: evalRunStatusSchema,
  metrics: evalRunMetricsSchema,
  passed: z.array(evalCaseResultSchema),
  failed: z.array(evalCaseResultSchema),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  stale: z.boolean().optional(),
});

export type CreateEvalSetInput = z.infer<typeof createEvalSetSchema>;
export type CreateEvalCaseInput = z.infer<typeof createEvalCaseSchema>;
export type RunEvalSetInput = z.infer<typeof runEvalSetSchema>;
export type EvalRunStatus = z.infer<typeof evalRunStatusSchema>;
export type EvalRunMetrics = z.infer<typeof evalRunMetricsSchema>;
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

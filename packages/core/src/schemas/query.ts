import { z } from 'zod';

export const filterOpSchema = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);

export const filterScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const normalizedFilterSchema = z.object({
  field: z.string().min(1),
  op: filterOpSchema,
  value: z.union([filterScalarSchema, z.array(filterScalarSchema)]),
});

export const queryRequestSchema = z.object({
  entity: z.string().min(1).optional(),
  query: z.string().min(1),
  filters: z.record(z.union([filterScalarSchema, z.array(filterScalarSchema)])).optional(),
  limit: z.coerce.number().int().positive().max(50).default(10),
  sourceId: z.string().uuid().optional(),
  useLlmFallback: z.boolean().optional().default(false),
});

export const queryTypeSchema = z.enum(['filter_only', 'lexical', 'hybrid_search']);

export const queryResultSchema = z.object({
  id: z.string().uuid(),
  entity: z.string(),
  score: z.number(),
  data: z.record(z.unknown()),
});

export const queryResponseSchema = z.object({
  results: z.array(queryResultSchema),
  applied_filters: z.array(normalizedFilterSchema),
  query_type: queryTypeSchema,
  confidence: z.number().min(0).max(1),
  sources_used: z.array(z.string().uuid()),
  warnings: z.array(z.string()),
});

export type FilterOp = z.infer<typeof filterOpSchema>;
export type NormalizedFilter = z.infer<typeof normalizedFilterSchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type QueryType = z.infer<typeof queryTypeSchema>;
export type QueryResult = z.infer<typeof queryResultSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;

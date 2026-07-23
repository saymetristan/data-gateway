import { z } from 'zod';

export const filterOpSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'containsAny',
  'containsAll',
]);

export const filterScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const normalizedFilterSchema = z.object({
  field: z.string().min(1),
  op: filterOpSchema,
  value: z.union([filterScalarSchema, z.array(filterScalarSchema)]),
});

export const queryPreferenceSchema = z.object({
  field: z.string().min(1),
  op: filterOpSchema.default('contains'),
  value: z.union([filterScalarSchema, z.array(filterScalarSchema)]),
  boost: z.number().min(0).max(1).optional(),
});

/** Legacy shorthand: { field: value } still accepted. */
const legacyFiltersSchema = z.record(
  z.union([filterScalarSchema, z.array(filterScalarSchema)]),
);

const queryRequestBaseSchema = z.object({
  entity: z.string().min(1).optional(),
  /** Free-text search. Optional when filters or preferences are supplied. */
  query: z.string().optional(),
  filters: z.union([legacyFiltersSchema, z.array(normalizedFilterSchema)]).optional(),
  preferences: z.array(queryPreferenceSchema).optional(),
  limit: z.coerce.number().int().positive().max(50).default(10),
  sourceId: z.string().uuid().optional(),
  useLlmFallback: z.boolean().optional().default(false),
});

export const queryRequestSchema = queryRequestBaseSchema.superRefine((value, ctx) => {
  const hasQuery = typeof value.query === 'string' && value.query.trim().length > 0;
  const hasFilters = (() => {
    if (!value.filters) return false;
    if (Array.isArray(value.filters)) return value.filters.length > 0;
    return Object.keys(value.filters).length > 0;
  })();
  const hasPreferences = (value.preferences?.length ?? 0) > 0;

  if (!hasQuery && !hasFilters && !hasPreferences) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide a non-empty query, at least one filter, or at least one preference',
      path: ['query'],
    });
  }
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
  applied_preferences: z.array(queryPreferenceSchema).optional(),
  query_type: queryTypeSchema,
  confidence: z.number().min(0).max(1),
  sources_used: z.array(z.string().uuid()),
  warnings: z.array(z.string()),
});

export type FilterOp = z.infer<typeof filterOpSchema>;
export type NormalizedFilter = z.infer<typeof normalizedFilterSchema>;
export type QueryPreference = z.infer<typeof queryPreferenceSchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type QueryType = z.infer<typeof queryTypeSchema>;
export type QueryResult = z.infer<typeof queryResultSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;

export function normalizeRequestFilters(
  filters: QueryRequest['filters'],
): NormalizedFilter[] {
  if (!filters) return [];
  if (Array.isArray(filters)) return filters;
  return Object.entries(filters).map(([field, value]) => ({
    field,
    op: Array.isArray(value) ? 'in' : 'eq',
    value,
  }));
}

export function requestHasFreeText(request: QueryRequest): boolean {
  return typeof request.query === 'string' && request.query.trim().length > 0;
}

export function requestQueryText(request: QueryRequest): string {
  return typeof request.query === 'string' ? request.query : '';
}

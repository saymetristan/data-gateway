import { z } from 'zod';
import { queryTypeSchema } from './query.js';

export const queryLogsListParamsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  queryType: queryTypeSchema.optional(),
  maxConfidence: z.coerce.number().min(0).max(1).optional(),
  sourceId: z.string().uuid().optional(),
  onlyErrors: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().datetime().optional(),
});

export const queryLogItemSchema = z.object({
  id: z.string().uuid(),
  apiKeyId: z.string().uuid().nullable(),
  sourceId: z.string().uuid().nullable(),
  rawQuery: z.string().nullable(),
  structuredQuery: z.record(z.string(), z.unknown()).nullable(),
  queryType: z.string().nullable(),
  appliedFilters: z.unknown().nullable(),
  resultsCount: z.number().nullable(),
  confidence: z.number().nullable(),
  latencyMs: z.number().nullable(),
  warnings: z.array(z.string()).nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export const queryLogsListResponseSchema = z.object({
  logs: z.array(queryLogItemSchema),
  nextCursor: z.string().nullable(),
});

export type QueryLogsListParams = z.infer<typeof queryLogsListParamsSchema>;
export type QueryLogItem = z.infer<typeof queryLogItemSchema>;
export type QueryLogsListResponse = z.infer<typeof queryLogsListResponseSchema>;

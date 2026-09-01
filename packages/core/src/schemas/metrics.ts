import { z } from 'zod';

export const operationalMetricsSchema = z.object({
  generatedAt: z.string(),
  windowHours: z.number().int().positive(),
  query: z.object({
    total: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    latencyMsP50: z.number().nullable(),
    latencyMsP95: z.number().nullable(),
  }),
  queues: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  embeddingIngestion: z.object({
    pendingJobs: z.number().int().nonnegative(),
    activeJobs: z.number().int().nonnegative(),
    retryJobs: z.number().int().nonnegative(),
    pendingRecords: z.number().int().nonnegative(),
    oldestPendingAt: z.string().nullable(),
    completedRecords15m: z.number().int().nonnegative(),
    completedRecords60m: z.number().int().nonnegative(),
    jobDurationMsP50: z.number().nullable(),
    jobDurationMsP95: z.number().nullable(),
  }),
  sync: z.object({
    webhookEvents: z.array(
      z.object({
        status: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
    sourcesByMaturity: z.array(
      z.object({
        maturityStatus: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
});

export type OperationalMetrics = z.infer<typeof operationalMetricsSchema>;

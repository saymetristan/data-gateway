import { z } from 'zod';

const encryptionKeySchema = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be base64-encoded 32 bytes');

export const workerEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
    OPENROUTER_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().default('qwen/qwen3-embedding-8b'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
    INGEST_EMBEDDING_SOFT_DEADLINE_MS: z.coerce.number().int().positive().default(10_000),
    INGEST_EMBEDDING_HARD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    INGEST_EMBEDDING_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    EMBEDDING_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    EMBEDDING_CIRCUIT_RECOVERY_MS: z.coerce.number().int().positive().default(30_000),
    INGEST_DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    INGEST_DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    EMBEDDING_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(1),
    EMBEDDING_PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
    INGEST_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(3).default(1),
    WORKER_PGBOSS_POOL_MAX: z.coerce.number().int().min(1).max(3).default(3),
    WORKER_INGESTION_PAUSED: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    LLM_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),
    USE_MOCK_PROVIDERS: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.EMBEDDING_JOB_CONCURRENCY > env.INGEST_DATABASE_POOL_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INGEST_DATABASE_POOL_MAX'],
        message: 'must be greater than or equal to EMBEDDING_JOB_CONCURRENCY',
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

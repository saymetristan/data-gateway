import { z } from 'zod';

const encryptionKeySchema = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be base64-encoded 32 bytes');

export const workerEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  OPENROUTER_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('qwen/qwen3-embedding-8b'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  EMBEDDING_SOFT_DEADLINE_MS: z.coerce.number().int().positive().default(2_500),
  EMBEDDING_HARD_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),
  EMBEDDING_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  EMBEDDING_CIRCUIT_RECOVERY_MS: z.coerce.number().int().positive().default(30_000),
  LLM_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),
  USE_MOCK_PROVIDERS: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
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

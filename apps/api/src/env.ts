import { z } from 'zod';

const encryptionKeySchema = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be base64-encoded 32 bytes');

export const apiEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_API_KEY: z.string().min(16),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = apiEnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

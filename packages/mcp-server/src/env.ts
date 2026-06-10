import { z } from 'zod';

const envSchema = z.object({
  GATEWAY_URL: z.string().url(),
  GATEWAY_API_KEY: z.string().min(1),
  MCP_PORT: z.coerce.number().int().positive().default(3100),
});

export type McpServerEnv = z.infer<typeof envSchema>;

export function loadMcpEnv(): McpServerEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid MCP server env: ${parsed.error.message}`);
  }
  return parsed.data;
}

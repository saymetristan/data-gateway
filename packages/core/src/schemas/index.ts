import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens'),
  settings: z.record(z.unknown()).optional(),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const createApiKeySchema = z.object({
  scopes: z.array(z.string()).optional().default([]),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

const databaseUrlSourceConfigSchema = z.object({
  connectionUrl: z.string().url(),
  tables: z.array(z.string()).optional(),
});

const csvSourceConfigSchema = z.object({
  fileName: z.string().optional(),
});

const shopifySourceConfigSchema = z.object({
  shopDomain: z.string(),
  accessToken: z.string(),
});

export const createSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('database_url'),
    name: z.string().min(1).max(255),
    config: databaseUrlSourceConfigSchema,
  }),
  z.object({
    type: z.literal('csv'),
    name: z.string().min(1).max(255),
    config: csvSourceConfigSchema.default({}),
  }),
  z.object({
    type: z.literal('shopify'),
    name: z.string().min(1).max(255),
    config: shopifySourceConfigSchema,
  }),
]);

export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const workspaceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  settings: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const apiKeyCreatedResponseSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
});

export const sourceResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: z.enum(['database_url', 'csv', 'shopify']),
  name: z.string(),
  maturityStatus: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

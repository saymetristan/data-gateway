import { z } from 'zod';

export const toolKindSchema = z.enum(['search', 'check_availability', 'suggest_filter_values']);

export const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  kind: toolKindSchema,
  description: z.string().min(1),
  entity: z.string().min(1),
  sourceIds: z.array(z.string().uuid()).min(1),
  mappingVersion: z.number().int().positive(),
  inputSchema: jsonSchemaObjectSchema,
  outputHints: z.record(z.string(), z.unknown()).optional(),
});

export const toolManifestSchema = z.object({
  workspaceId: z.string().uuid(),
  generatedAt: z.string(),
  warnings: z.array(z.string()).default([]),
  tools: z.array(toolDefinitionSchema),
});

export const toolInvokeRequestSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});

export const toolInvokeResponseSchema = z.union([
  z.object({
    kind: z.literal('search'),
    results: z.array(
      z.object({
        id: z.string().uuid(),
        entity: z.string(),
        score: z.number(),
        data: z.record(z.string(), z.unknown()),
      }),
    ),
    applied_filters: z.array(
      z.object({
        field: z.string(),
        op: z.string(),
        value: z.unknown(),
      }),
    ),
    applied_preferences: z
      .array(
        z.object({
          field: z.string(),
          op: z.string(),
          value: z.unknown(),
          boost: z.number().optional(),
        }),
      )
      .optional(),
    query_type: z.enum(['filter_only', 'lexical', 'hybrid_search']),
    confidence: z.number(),
    sources_used: z.array(z.string().uuid()),
    warnings: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('check_availability'),
    available: z.boolean(),
    matches: z.array(
      z.object({
        id: z.string().uuid(),
        entity: z.string(),
        data: z.record(z.string(), z.unknown()),
      }),
    ),
    warnings: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('suggest_filter_values'),
    field: z.string(),
    values: z.array(
      z.object({
        value: z.union([z.string(), z.number(), z.boolean()]),
        displayValue: z.string().optional(),
        count: z.number().int().nonnegative(),
      }),
    ),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  }),
]);

export type ToolKind = z.infer<typeof toolKindSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type ToolInvokeRequest = z.infer<typeof toolInvokeRequestSchema>;
export type ToolInvokeResponse = z.infer<typeof toolInvokeResponseSchema>;

import { z } from 'zod';

export const mappingFieldTypeSchema = z.enum(['string', 'number', 'boolean', 'date']);

export const mappingFieldSchema = z.object({
  name: z.string().min(1),
  sourceColumn: z.string().min(1),
  type: mappingFieldTypeSchema,
  searchable: z.boolean().default(false),
  filterable: z.boolean().default(false),
  visible: z.boolean().default(true),
  sensitive: z.boolean().default(false),
});

export const mappingRuleSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  column: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const mappingDefaultFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in']),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]),
});

export const mappingEnrichmentSchema = z.object({
  prompt: z.string().min(1),
  inputFields: z.array(z.string().min(1)).min(1),
  outputFields: z.array(
    z.object({
      name: z.string().min(1),
      type: mappingFieldTypeSchema,
    }),
  ).min(1),
});

export const mappingEntitySchema = z.object({
  entity: z.string().min(1),
  sourceTable: z.string().min(1),
  fields: z.array(mappingFieldSchema).min(1),
  rules: z.array(mappingRuleSchema).default([]),
  defaultFilters: z.array(mappingDefaultFilterSchema).default([]),
  embeddingTextTemplate: z.string().min(1),
  enrichment: mappingEnrichmentSchema.optional(),
});

export const mappingDocumentSchema = z.object({
  entities: z.array(mappingEntitySchema).min(1),
});

export type MappingDocument = z.infer<typeof mappingDocumentSchema>;
export type MappingEntity = z.infer<typeof mappingEntitySchema>;
export type MappingField = z.infer<typeof mappingFieldSchema>;
export type MappingRule = z.infer<typeof mappingRuleSchema>;

export const createMappingSchema = z.object({
  document: mappingDocumentSchema,
});

export type CreateMappingInput = z.infer<typeof createMappingSchema>;

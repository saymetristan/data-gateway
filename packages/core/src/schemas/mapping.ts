import { z } from 'zod';

export const mappingFieldTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'json']);

export const mappingFieldSchema = z
  .object({
    name: z.string().min(1),
    sourceColumn: z.string().min(1),
    type: mappingFieldTypeSchema,
    description: z.string().optional(),
    label: z.string().min(1).optional(),
    filterLabel: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]),
    identifier: z.boolean().default(false),
    jsonPath: z.string().min(1).optional(),
    searchable: z.boolean().default(false),
    filterable: z.boolean().default(false),
    visible: z.boolean().default(true),
    sensitive: z.boolean().default(false),
  })
  .refine((field) => !field.sensitive || (!field.searchable && !field.filterable), {
    message: 'Sensitive fields cannot be searchable or filterable',
  });

export const mappingRuleConditionSchema = z.object({
  column: z.string().min(1),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const mappingRuleSchema = z
  .object({
    field: z.string().min(1),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]),
    op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']).optional(),
    column: z.string().min(1).optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    conditions: z.array(mappingRuleConditionSchema).min(1).optional(),
  })
  .refine(
    (rule) =>
      (rule.conditions?.length ?? 0) > 0 ||
      (rule.op !== undefined && rule.column !== undefined && rule.value !== undefined),
    { message: 'Rule must define either conditions or op/column/value' },
  )
  .refine(
    (rule) =>
      !(
        (rule.conditions?.length ?? 0) > 0 &&
        (rule.op !== undefined || rule.column !== undefined || rule.value !== undefined)
      ),
    { message: 'Rule cannot mix conditions with op/column/value' },
  );

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

export const mappingRelationAggregateSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  viaTable: z.string().min(1),
  sourceColumn: z.string().min(1),
  viaSourceColumn: z.string().min(1),
  viaTargetColumn: z.string().min(1),
  targetTable: z.string().min(1),
  targetColumn: z.string().min(1).default('id'),
  targetLabelColumn: z.string().min(1).optional(),
  searchable: z.boolean().default(true),
  visible: z.boolean().default(true),
});

export const mappingEntitySchema = z.object({
  entity: z.string().min(1),
  description: z.string().optional(),
  displayName: z.string().min(1).optional(),
  pluralLabel: z.string().min(1).optional(),
  sourceKind: z.enum(['entity', 'lookup', 'junction', 'config']).optional(),
  exposeAsTool: z.boolean().optional(),
  sourceTable: z.string().min(1),
  fields: z.array(mappingFieldSchema).min(1),
  rules: z.array(mappingRuleSchema).default([]),
  relationAggregates: z.array(mappingRelationAggregateSchema).default([]),
  defaultFilters: z.array(mappingDefaultFilterSchema).default([]),
  embeddingTextTemplate: z.string().min(1),
  enrichment: mappingEnrichmentSchema.optional(),
});

export const mappingDocumentSchema = z.object({
  entities: z.array(mappingEntitySchema).min(1),
});

type ParsedMappingField = z.infer<typeof mappingFieldSchema>;
type ParsedMappingRule = z.infer<typeof mappingRuleSchema>;
type ParsedMappingEntity = z.infer<typeof mappingEntitySchema>;

export type MappingField = Omit<ParsedMappingField, 'aliases' | 'identifier'> & {
  aliases?: string[];
  identifier?: boolean;
};
export type MappingRule = Omit<ParsedMappingRule, 'aliases'> & {
  aliases?: string[];
};
export type MappingRelationAggregate = z.infer<typeof mappingRelationAggregateSchema>;
export type MappingEntity = Omit<
  ParsedMappingEntity,
  'fields' | 'rules' | 'relationAggregates'
> & {
  fields: MappingField[];
  rules: MappingRule[];
  relationAggregates?: MappingRelationAggregate[];
};
export type MappingDocument = Omit<z.infer<typeof mappingDocumentSchema>, 'entities'> & {
  entities: MappingEntity[];
};

export const createMappingSchema = z.object({
  document: mappingDocumentSchema,
});

export type CreateMappingInput = z.infer<typeof createMappingSchema>;

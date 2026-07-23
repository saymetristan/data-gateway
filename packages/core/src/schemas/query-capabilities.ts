import { z } from 'zod';
import { filterOpSchema } from './query.js';

export const queryCapabilityValueSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  displayValue: z.string().optional(),
  count: z.number().int().nonnegative(),
});

export const queryFieldCapabilitySchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  filterLabel: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'json']),
  aliases: z.array(z.string()),
  description: z.string().optional(),
  cardinality: z.enum(['one', 'many']),
  operators: z.array(filterOpSchema),
  filterable: z.boolean(),
  preferable: z.boolean(),
  inferredBehavior: z.enum(['filter', 'prefer', 'search']),
  match: z.enum(['eq', 'contains', 'containsAny', 'containsAll']),
  boost: z.number().min(0).max(1).optional(),
  min: z.union([z.string(), z.number()]).optional(),
  max: z.union([z.string(), z.number()]).optional(),
  suggestedValues: z.array(queryCapabilityValueSchema).default([]),
  suggestedValuesTruncated: z.boolean().default(false),
});

export const queryEntityCapabilitySchema = z.object({
  entity: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  sourceIds: z.array(z.string().uuid()),
  mappingVersion: z.number().int().positive(),
  fields: z.array(queryFieldCapabilitySchema),
});

export const queryCapabilitiesResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  generatedAt: z.string(),
  entities: z.array(queryEntityCapabilitySchema),
  warnings: z.array(z.string()).default([]),
});

export type QueryCapabilityValue = z.infer<typeof queryCapabilityValueSchema>;
export type QueryFieldCapability = z.infer<typeof queryFieldCapabilitySchema>;
export type QueryEntityCapability = z.infer<typeof queryEntityCapabilitySchema>;
export type QueryCapabilitiesResponse = z.infer<typeof queryCapabilitiesResponseSchema>;

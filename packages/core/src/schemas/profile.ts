import { z } from 'zod';

export const profileColumnSchema = z.object({
  name: z.string(),
  inferredType: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'json', 'unknown']),
  cardinality: z.number().int().nonnegative(),
  nullCount: z.number().int().nonnegative(),
  nullRate: z.number().min(0).max(1),
  topValues: z.array(
    z.object({
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      count: z.number().int().nonnegative(),
    }),
  ),
  min: z.union([z.string(), z.number()]).optional(),
  max: z.union([z.string(), z.number()]).optional(),
});

export const profileTableSchema = z.object({
  table: z.string(),
  recordCount: z.number().int().nonnegative(),
  columns: z.array(profileColumnSchema),
});

export const sourceProfileDocumentSchema = z.object({
  tables: z.array(profileTableSchema),
  totalRecords: z.number().int().nonnegative(),
  profiledAt: z.string(),
});

export type SourceProfileDocument = z.infer<typeof sourceProfileDocumentSchema>;
export type ProfileColumn = z.infer<typeof profileColumnSchema>;

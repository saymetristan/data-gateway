import { z } from 'zod';

const profileValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const profileAtomicValueSchema = z.object({
  /** Canonical value used for matching and filters. */
  value: z.union([z.string(), z.number(), z.boolean()]),
  /** Optional display label when it differs from the canonical value. */
  displayValue: z.string().optional(),
  count: z.number().int().nonnegative(),
});

export const profileColumnSchema = z.object({
  name: z.string(),
  inferredType: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'json', 'unknown']),
  cardinality: z.number().int().nonnegative(),
  nullCount: z.number().int().nonnegative(),
  nullRate: z.number().min(0).max(1),
  topValues: z.array(
    z.object({
      value: profileValueSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
  suggestedValues: z.array(
    z.object({
      value: profileValueSchema,
      count: z.number().int().nonnegative(),
    }),
  ).optional(),
  /**
   * Atomic members for array/CSV-like JSON columns (e.g. collections).
   * Used by NL extraction, capabilities, and tool enums.
   */
  atomicValues: z.array(profileAtomicValueSchema).optional(),
  atomicValuesTruncated: z.boolean().optional(),
  enumCandidate: z.boolean().optional(),
  jsonShape: z.record(
    z.string(),
    z.object({
      inferredType: z.enum(['string', 'number', 'boolean', 'date', 'datetime', 'json', 'unknown']),
      cardinality: z.number().int().nonnegative(),
      topValues: z.array(
        z.object({
          value: profileValueSchema,
          count: z.number().int().nonnegative(),
        }),
      ),
    }),
  ).optional(),
  min: z.union([z.string(), z.number()]).optional(),
  max: z.union([z.string(), z.number()]).optional(),
});

export const profileForeignKeySchema = z.object({
  column: z.string(),
  referencedTable: z.string(),
  referencedColumn: z.string(),
});

export const profileTableSchema = z.object({
  table: z.string(),
  schema: z.string().optional(),
  tableRole: z.enum(['entity', 'lookup', 'junction', 'config']).optional(),
  primaryKey: z.array(z.string()).optional(),
  foreignKeys: z.array(profileForeignKeySchema).optional(),
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

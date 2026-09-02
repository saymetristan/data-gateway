import { z } from 'zod';

const MAX_ENTITIES = 20;
const MAX_TERMS_PER_ENTITY = 500;
const MAX_SYNONYMS_PER_TERM = 20;
const MAX_TERM_LENGTH = 120;
const MAX_DOCUMENT_CHARS = 100_000;
const MAX_FIELDS_PER_ENTITY = 50;
const MAX_ALIASES_PER_FIELD = 20;
const MAX_VALUE_ALIAS_KEYS = 200;

const synonymValueSchema = z.string().trim().min(1).max(MAX_TERM_LENGTH);

export const retrievalSynonymEntriesSchema = z
  .record(
    z.string().trim().min(1).max(MAX_TERM_LENGTH),
    z.array(synonymValueSchema).min(1).max(MAX_SYNONYMS_PER_TERM),
  )
  .superRefine((entries, ctx) => {
    const keys = Object.keys(entries);
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one synonym term is required per entity',
      });
    }
    if (keys.length > MAX_TERMS_PER_ENTITY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${String(MAX_TERMS_PER_ENTITY)} synonym terms are allowed per entity`,
      });
    }

    const normalizedKeys = new Set<string>();
    for (const [term, synonyms] of Object.entries(entries)) {
      const normalizedTerm = normalizeVocabularyTerm(term);
      if (normalizedKeys.has(normalizedTerm)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [term],
          message: 'Duplicate term after case/accent normalization',
        });
      }
      normalizedKeys.add(normalizedTerm);

      const normalizedSynonyms = new Set<string>();
      for (let index = 0; index < synonyms.length; index += 1) {
        const synonym = synonyms[index];
        if (!synonym) continue;
        const normalizedSynonym = normalizeVocabularyTerm(synonym);
        if (normalizedSynonym === normalizedTerm) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [term, index],
            message: 'A term cannot be its own synonym',
          });
        }
        if (normalizedSynonyms.has(normalizedSynonym)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [term, index],
            message: 'Duplicate synonym after case/accent normalization',
          });
        }
        normalizedSynonyms.add(normalizedSynonym);
      }
    }
  });

export const retrievalPolicyFieldSchema = z
  .object({
    field: z.string().trim().min(1).max(100),
    aliases: z.array(z.string().trim().min(1).max(MAX_TERM_LENGTH)).max(MAX_ALIASES_PER_FIELD).default([]),
    valueAliases: z
      .record(
        z.string().trim().min(1).max(MAX_TERM_LENGTH),
        z.array(synonymValueSchema).min(1).max(MAX_SYNONYMS_PER_TERM),
      )
      .optional()
      .superRefine((entries, ctx) => {
        if (!entries) return;
        if (Object.keys(entries).length > MAX_VALUE_ALIAS_KEYS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `At most ${String(MAX_VALUE_ALIAS_KEYS)} value alias keys are allowed per field`,
          });
        }
      }),
    implicitBehavior: z.enum(['filter', 'prefer', 'search']).optional(),
    match: z.enum(['eq', 'contains', 'containsAny', 'containsAll']).optional(),
    boost: z.number().min(0).max(1).optional(),
  })
  .strict();

export const retrievalPolicyEntitySchema = z
  .object({
    entity: z.string().trim().min(1).max(100),
    synonyms: z
      .object({
        entries: retrievalSynonymEntriesSchema,
      })
      .strict()
      .optional(),
    fields: z.array(retrievalPolicyFieldSchema).max(MAX_FIELDS_PER_ENTITY).default([]),
    rrf: z
      .object({
        lexicalWeight: z.number().positive(),
        vectorWeight: z.number().positive(),
      })
      .strict()
      .optional(),
    quality: z
      .object({
        minRelevance: z.number().min(0).max(1).optional(),
        minPrimaryFieldCoverage: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((entity, ctx) => {
    const hasSynonyms = Boolean(entity.synonyms && Object.keys(entity.synonyms.entries).length > 0);
    const hasFields = entity.fields.length > 0;
    const hasRrf = Boolean(entity.rrf);
    const hasQuality = Boolean(entity.quality);
    if (!hasSynonyms && !hasFields && !hasRrf && !hasQuality) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Entity policy must define synonyms, fields, rrf, or quality',
      });
    }

    const seenFields = new Set<string>();
    for (let index = 0; index < entity.fields.length; index += 1) {
      const field = entity.fields[index];
      if (!field) continue;
      const normalized = field.field.toLowerCase();
      if (seenFields.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'field'],
          message: 'Duplicate field policy',
        });
      }
      seenFields.add(normalized);
    }
  });

export const retrievalPolicyDocumentSchema = z
  .object({ entities: z.array(retrievalPolicyEntitySchema).min(1).max(MAX_ENTITIES) })
  .strict()
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < document.entities.length; index += 1) {
      const entity = document.entities[index];
      if (!entity) continue;
      const normalized = entity.entity.toLowerCase();
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entities', index, 'entity'],
          message: 'Duplicate entity',
        });
      }
      seen.add(normalized);
    }

    if (JSON.stringify(document).length > MAX_DOCUMENT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Retrieval policy document exceeds ${String(MAX_DOCUMENT_CHARS)} characters`,
      });
    }
  });

export const createRetrievalPolicySchema = z
  .object({
    document: retrievalPolicyDocumentSchema,
    expectedActiveVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export const activateRetrievalPolicySchema = z
  .object({
    expectedActiveVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type RetrievalPolicyField = z.infer<typeof retrievalPolicyFieldSchema>;
export type RetrievalPolicyDocument = z.infer<typeof retrievalPolicyDocumentSchema>;
export type CreateRetrievalPolicyInput = z.infer<typeof createRetrievalPolicySchema>;
export type ActivateRetrievalPolicyInput = z.infer<
  typeof activateRetrievalPolicySchema
>;

export function normalizeVocabularyTerm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

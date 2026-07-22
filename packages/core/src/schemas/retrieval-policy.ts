import { z } from 'zod';

const MAX_ENTITIES = 20;
const MAX_TERMS_PER_ENTITY = 500;
const MAX_SYNONYMS_PER_TERM = 20;
const MAX_TERM_LENGTH = 120;
const MAX_DOCUMENT_CHARS = 100_000;

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

export const retrievalPolicyEntitySchema = z
  .object({
    entity: z.string().trim().min(1).max(100),
    synonyms: z
      .object({
        entries: retrievalSynonymEntriesSchema,
      })
      .strict(),
  })
  .strict();

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

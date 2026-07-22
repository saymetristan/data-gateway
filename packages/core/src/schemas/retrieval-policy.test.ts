import { describe, expect, it } from 'vitest';
import {
  createRetrievalPolicySchema,
  normalizeVocabularyTerm,
} from './retrieval-policy.js';

describe('retrieval policy schema', () => {
  it('accepts a bounded Bayon synonym document', () => {
    const parsed = createRetrievalPolicySchema.parse({
      expectedActiveVersion: 0,
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: {
              entries: {
                aida: ['cuadrille aida', 'cuadrillé'],
                'punto de cruz': ['aida', 'etamina'],
              },
            },
          },
        ],
      },
    });
    expect(parsed.document.entities[0]?.entity).toBe('variant');
  });

  it('rejects self-synonyms after accent and case normalization', () => {
    const parsed = createRetrievalPolicySchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: {
              entries: {
                'Cuadrillé': ['cuadrille'],
              },
            },
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate entities', () => {
    const parsed = createRetrievalPolicySchema.safeParse({
      document: {
        entities: [
          { entity: 'variant', synonyms: { entries: { aida: ['cuadrille'] } } },
          { entity: 'VARIANT', synonyms: { entries: { etamina: ['caneva'] } } },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects undeclared policy fields', () => {
    const parsed = createRetrievalPolicySchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: { entries: { aida: ['cuadrille'] } },
            rrf: { lexicalWeight: 99 },
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('normalizes accents, case, and whitespace for comparisons', () => {
    expect(normalizeVocabularyTerm('  Cuadrillé  AIDA ')).toBe('cuadrille aida');
  });
});

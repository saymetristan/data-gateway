import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createRetrievalPolicySchema,
  normalizeVocabularyTerm,
} from './retrieval-policy.js';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/bayon-retrieval-policy.json',
);

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

  it('accepts field policies and query-time rrf overrides', () => {
    const parsed = createRetrievalPolicySchema.parse({
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: { entries: { aida: ['cuadrille'] } },
            fields: [
              {
                field: 'collections',
                aliases: ['linea', 'línea'],
                implicitBehavior: 'filter',
                match: 'contains',
                boost: 0.4,
              },
            ],
            rrf: { lexicalWeight: 1.2, vectorWeight: 1 },
          },
        ],
      },
    });
    expect(parsed.document.entities[0]?.fields[0]?.field).toBe('collections');
    expect(parsed.document.entities[0]?.rrf?.lexicalWeight).toBe(1.2);
  });

  it('rejects undeclared nested policy properties', () => {
    const parsed = createRetrievalPolicySchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: { entries: { aida: ['cuadrille'] } },
            unknown: true,
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('normalizes accents, case, and whitespace for comparisons', () => {
    expect(normalizeVocabularyTerm('  Cuadrillé  AIDA ')).toBe('cuadrille aida');
  });

  it('accepts the Bayon retrieval policy fixture', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    expect(createRetrievalPolicySchema.safeParse(fixture).success).toBe(true);
  });

  it('rejects accent-equivalent term keys like the invalid Bayon v1 payload', () => {
    const parsed = createRetrievalPolicySchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: {
              entries: {
                caneva: ['etamina'],
                canevá: ['etamina'],
                cuadrille: ['aida'],
                cuadrillé: ['aida'],
              },
            },
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });
});

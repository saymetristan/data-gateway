import { describe, expect, it } from 'vitest';
import {
  parseStoredActivePolicy,
  resolveEntitySynonyms,
  type ActiveRetrievalPolicy,
} from './retrieval-policies.js';

const policy: ActiveRetrievalPolicy = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceId: '22222222-2222-4222-8222-222222222222',
  version: 3,
  document: {
    entities: [
      {
        entity: 'variant',
        synonyms: {
          entries: {
            aida: ['cuadrille aida'],
          },
        },
        fields: [],
      },
    ],
  },
};

describe('resolveEntitySynonyms', () => {
  it('uses versioned policy synonyms as an entity-level override', () => {
    expect(
      resolveEntitySynonyms(policy, 'variant', {
        version: 'legacy-v2',
        entries: { vinipiel: ['ecocuero'] },
      }),
    ).toEqual({
      version: 'retrieval-policy-v3',
      entries: { aida: ['cuadrille aida'] },
    });
  });

  it('falls back to mapping synonyms when no policy covers the entity', () => {
    const legacy = {
      version: 'legacy-v2',
      entries: { vinipiel: ['ecocuero'] },
    };
    expect(resolveEntitySynonyms(policy, 'product', legacy)).toEqual(legacy);
    expect(resolveEntitySynonyms(undefined, 'variant', legacy)).toEqual(legacy);
  });
});

describe('parseStoredActivePolicy', () => {
  it('accepts a valid persisted document', () => {
    const result = parseStoredActivePolicy({
      id: policy.id,
      sourceId: policy.sourceId,
      version: policy.version,
      document: policy.document,
    });
    expect(result).toEqual({ policy });
  });

  it('fails open on accent-duplicate keys instead of throwing', () => {
    const result = parseStoredActivePolicy({
      id: policy.id,
      sourceId: policy.sourceId,
      version: 1,
      document: {
        entities: [
          {
            entity: 'variant',
            synonyms: {
              entries: {
                cuadrille: ['aida'],
                cuadrillé: ['aida'],
              },
            },
          },
        ],
      },
    });
    expect(result).toEqual({
      warning:
        'Active retrieval policy v1 for source 22222222-2222-4222-8222-222222222222 is invalid and was ignored; using mapping synonyms',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyPreferenceRescore,
  hasAnyPreferenceMatch,
  rankByPreferenceCoverage,
} from './rescore.js';
import type { MappingField } from '../schemas/mapping.js';

describe('applyPreferenceRescore', () => {
  const fields = new Map<string, MappingField>([
    [
      'collections',
      {
        name: 'collections',
        sourceColumn: 'collections',
        type: 'json',
        searchable: true,
        filterable: true,
        visible: true,
        sensitive: false,
        retrieval: {
          cardinality: 'many',
          match: 'contains',
          inferredBehavior: 'prefer',
          boost: 0.3,
          searchWeight: 'B',
        },
      },
    ],
    [
      'color',
      {
        name: 'color',
        sourceColumn: 'color',
        type: 'string',
        searchable: true,
        filterable: true,
        visible: true,
        sensitive: false,
        retrieval: {
          cardinality: 'one',
          match: 'eq',
          inferredBehavior: 'prefer',
          boost: 0.25,
          searchWeight: 'B',
        },
      },
    ],
  ]);

  it('boosts matching preferences without dropping non-matches', () => {
    const result = applyPreferenceRescore(
      [
        { id: 'a', score: 1, data: { collections: ['Invierno'] } },
        { id: 'b', score: 0.9, data: { collections: ['Verano', 'Ofertas'] } },
      ],
      [{ field: 'collections', op: 'contains', value: 'Verano', boost: 0.3 }],
      fields,
    );

    expect(result.hits[0]?.id).toBe('b');
    expect(result.hits.map((hit) => hit.id)).toEqual(['b', 'a']);
    expect(result.signalsById.get('b')?.[0]?.matched).toBe(true);
    expect(result.signalsById.get('b')?.[0]?.matchedValues).toEqual(['Verano']);
    expect(result.signalsById.get('a')?.[0]?.matched).toBe(false);
  });

  it('treats multiple values for one field as OR with max boost, not sum', () => {
    const result = applyPreferenceRescore(
      [{ id: 'a', score: 1, data: { color: 'Azul Rey' } }],
      [
        { field: 'color', op: 'eq', value: 'Azul', boost: 0.25 },
        { field: 'color', op: 'eq', value: 'Azul Rey', boost: 0.35 },
      ],
      fields,
    );

    expect(result.hits[0]?.score).toBeCloseTo(1.35);
    expect(result.signalsById.get('a')).toEqual([
      {
        field: 'color',
        boost: 0.35,
        matched: true,
        matchedValues: ['Azul Rey'],
      },
    ]);
  });

  it('caps boosts stacked across different fields', () => {
    const result = applyPreferenceRescore(
      [{ id: 'a', score: 1, data: { collections: ['Verano'], color: 'Azul' } }],
      [
        { field: 'collections', op: 'contains', value: 'Verano', boost: 0.5 },
        { field: 'color', op: 'eq', value: 'Azul', boost: 0.5 },
      ],
      fields,
    );
    expect(result.hits[0]?.score).toBeCloseTo(1.75);
  });

  it('ranks preference coverage before raw score and backfills unmatched hits', () => {
    const rescored = applyPreferenceRescore(
      [
        { id: 'none', score: 2, data: { collections: ['Invierno'], color: 'Rojo' } },
        { id: 'one', score: 1, data: { collections: ['Verano'], color: 'Rojo' } },
        { id: 'two', score: 0.8, data: { collections: ['Verano'], color: 'Azul' } },
      ],
      [
        { field: 'collections', op: 'contains', value: 'Verano', boost: 0.3 },
        { field: 'color', op: 'eq', value: 'Azul', boost: 0.25 },
      ],
      fields,
    );

    const ranked = rankByPreferenceCoverage(rescored.hits, rescored.signalsById);
    expect(ranked.map((hit) => hit.id)).toEqual(['two', 'one', 'none']);
    expect(hasAnyPreferenceMatch(ranked, rescored.signalsById)).toBe(true);
  });

  it('reports no preference matches while retaining semantic fallback candidates', () => {
    const rescored = applyPreferenceRescore(
      [{ id: 'fallback', score: 1, data: { color: 'Rojo' } }],
      [{ field: 'color', op: 'eq', value: 'Naranja', boost: 0.25 }],
      fields,
    );

    expect(hasAnyPreferenceMatch(rescored.hits, rescored.signalsById)).toBe(false);
    expect(rankByPreferenceCoverage(rescored.hits, rescored.signalsById)).toHaveLength(1);
  });
});

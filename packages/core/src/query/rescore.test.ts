import { describe, expect, it } from 'vitest';
import { applyPreferenceRescore } from './rescore.js';
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
    expect(result.signalsById.get('a')?.[0]?.matched).toBe(false);
  });

  it('caps stacked boosts', () => {
    const result = applyPreferenceRescore(
      [{ id: 'a', score: 1, data: { collections: ['Verano'], brand: 'X' } }],
      [
        { field: 'collections', op: 'contains', value: 'Verano', boost: 0.5 },
        { field: 'collections', op: 'contains', value: 'Verano', boost: 0.5 },
      ],
      fields,
    );
    expect(result.hits[0]?.score).toBeCloseTo(1.75);
  });
});

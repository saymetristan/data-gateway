import { describe, expect, it } from 'vitest';
import type { ProfileColumn } from '../schemas/profile.js';
import { collectSuggestedValues } from './query-capabilities.js';

describe('collectSuggestedValues', () => {
  it('prefers atomic values for multi-value columns', () => {
    const column: ProfileColumn = {
      name: 'collections',
      inferredType: 'json',
      cardinality: 3,
      nullCount: 0,
      nullRate: 0,
      topValues: [],
      suggestedValues: [{ value: 'Verano,Ofertas', count: 2 }],
      atomicValues: [
        { value: 'Verano', count: 5 },
        { value: 'Ofertas', count: 3 },
        { value: 'Invierno', count: 1 },
      ],
    };

    const result = collectSuggestedValues(column, true);
    expect(result.values.map((item) => item.value)).toEqual([
      'Verano',
      'Ofertas',
      'Invierno',
    ]);
    expect(result.truncated).toBe(false);
  });
});

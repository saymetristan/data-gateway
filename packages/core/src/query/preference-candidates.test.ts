import { describe, expect, it } from 'vitest';
import { buildPreferenceCandidateFilterSets } from './preference-candidates.js';

describe('buildPreferenceCandidateFilterSets', () => {
  it('keeps hard filters and queries same-field alternatives independently', () => {
    const sets = buildPreferenceCandidateFilterSets(
      [{ field: 'available', op: 'eq', value: true }],
      [
        { field: 'color', op: 'eq', value: 'Azul', boost: 0.25 },
        { field: 'color', op: 'eq', value: 'Azul Rey', boost: 0.25 },
      ],
      new Set(['available', 'color']),
    );

    expect(sets).toEqual([
      [
        { field: 'available', op: 'eq', value: true },
        { field: 'color', op: 'eq', value: 'Azul' },
      ],
      [
        { field: 'available', op: 'eq', value: true },
        { field: 'color', op: 'eq', value: 'Azul Rey' },
      ],
    ]);
  });

  it('deduplicates preferences and ignores non-filterable fields', () => {
    const sets = buildPreferenceCandidateFilterSets(
      [],
      [
        { field: 'color', op: 'eq', value: 'Naranja' },
        { field: 'color', op: 'eq', value: 'Naranja' },
        { field: 'description', op: 'contains', value: 'repelente' },
      ],
      new Set(['color']),
    );

    expect(sets).toEqual([[{ field: 'color', op: 'eq', value: 'Naranja' }]]);
  });
});

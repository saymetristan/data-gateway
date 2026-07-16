import { describe, expect, it } from 'vitest';
import type { MappingField } from '../schemas/mapping.js';
import { buildRelaxedRetrievalState } from './relax-filters.js';

describe('buildRelaxedRetrievalState', () => {
  const fieldsByName = new Map<string, MappingField>([
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
        retrieval: { inferredBehavior: 'filter', boost: 0.3, match: 'eq', cardinality: 'one' },
      },
    ],
    [
      'fabricType',
      {
        name: 'fabricType',
        sourceColumn: 'fabricType',
        type: 'string',
        searchable: true,
        filterable: true,
        visible: true,
        sensitive: false,
      },
    ],
    [
      'available',
      {
        name: 'available',
        sourceColumn: 'available',
        type: 'boolean',
        searchable: false,
        filterable: true,
        visible: true,
        sensitive: false,
      },
    ],
  ]);

  it('demotes implicit filters to preferences and keeps protected filters', () => {
    const result = buildRelaxedRetrievalState({
      safeFilters: [
        { field: 'fabricType', op: 'eq', value: 'Paño' },
        { field: 'color', op: 'eq', value: 'Verde' },
        { field: 'available', op: 'eq', value: true },
      ],
      appliedPreferences: [],
      implicitFilters: [
        { field: 'fabricType', op: 'eq', value: 'Paño' },
        { field: 'color', op: 'eq', value: 'Verde' },
      ],
      protectedFilters: [{ field: 'available', op: 'eq', value: true }],
      fieldsByName,
    });

    expect(result).not.toBeNull();
    expect(result?.filters).toEqual([{ field: 'available', op: 'eq', value: true }]);
    expect(result?.demoted).toEqual([
      { field: 'fabricType', op: 'eq', value: 'Paño' },
      { field: 'color', op: 'eq', value: 'Verde' },
    ]);
    expect(result?.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'fabricType', op: 'eq', value: 'Paño', boost: 0.25 }),
        expect.objectContaining({ field: 'color', op: 'eq', value: 'Verde', boost: 0.3 }),
      ]),
    );
  });

  it('returns null when only explicit/protected filters remain', () => {
    const result = buildRelaxedRetrievalState({
      safeFilters: [{ field: 'color', op: 'eq', value: 'rojo' }],
      appliedPreferences: [],
      implicitFilters: [],
      protectedFilters: [{ field: 'color', op: 'eq', value: 'rojo' }],
      fieldsByName,
    });
    expect(result).toBeNull();
  });

  it('does not demote an implicit filter that is also protected', () => {
    const result = buildRelaxedRetrievalState({
      safeFilters: [
        { field: 'color', op: 'eq', value: 'rojo' },
        { field: 'fabricType', op: 'eq', value: 'Lino' },
      ],
      appliedPreferences: [],
      implicitFilters: [
        { field: 'color', op: 'eq', value: 'rojo' },
        { field: 'fabricType', op: 'eq', value: 'Lino' },
      ],
      protectedFilters: [{ field: 'color', op: 'eq', value: 'rojo' }],
      fieldsByName,
    });

    expect(result?.demoted).toEqual([{ field: 'fabricType', op: 'eq', value: 'Lino' }]);
    expect(result?.filters).toEqual([{ field: 'color', op: 'eq', value: 'rojo' }]);
  });
});

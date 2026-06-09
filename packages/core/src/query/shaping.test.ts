import { describe, it, expect } from 'vitest';
import type { MappingField } from '../schemas/mapping.js';
import { shapeAppliedFilters, shapeRecordData } from './shaping.js';

const fields: MappingField[] = [
  { name: 'sku', sourceColumn: 'sku', type: 'string', searchable: true, filterable: true, visible: true, sensitive: false },
  { name: 'name', sourceColumn: 'name', type: 'string', searchable: true, filterable: false, visible: true, sensitive: false },
  { name: 'cost', sourceColumn: 'cost', type: 'number', searchable: false, filterable: true, visible: true, sensitive: true },
  { name: 'internal_note', sourceColumn: 'internal_note', type: 'string', searchable: false, filterable: false, visible: false, sensitive: false },
];

describe('shaping', () => {
  it('excluye campos sensitive e invisible del data', () => {
    const shaped = shapeRecordData(
      {
        sku: 'SKU-1',
        name: 'Camiseta',
        cost: 12,
        internal_note: 'secreto',
      },
      fields,
    );

    expect(shaped).toEqual({ sku: 'SKU-1', name: 'Camiseta' });
  });

  it('excluye filtros sensibles de applied_filters', () => {
    const shaped = shapeAppliedFilters(
      [
        { field: 'sku', op: 'eq', value: 'SKU-1' },
        { field: 'cost', op: 'lt', value: 20 },
      ],
      fields,
    );

    expect(shaped).toEqual([{ field: 'sku', op: 'eq', value: 'SKU-1' }]);
  });
});

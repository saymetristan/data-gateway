import { describe, it, expect } from 'vitest';
import {
  applyFieldMapping,
  applyRules,
  buildSearchSource,
  renderTemplate,
} from './apply.js';

describe('mapping apply', () => {
  it('maps fields and applies rules', () => {
    const payload = { name: 'Camiseta', stock: 5, price: '19.99' };
    const fields = [
      {
        name: 'name',
        sourceColumn: 'name',
        type: 'string' as const,
        searchable: true,
        filterable: false,
        visible: true,
        sensitive: false,
      },
      {
        name: 'stock',
        sourceColumn: 'stock',
        type: 'number' as const,
        searchable: false,
        filterable: true,
        visible: true,
        sensitive: false,
      },
    ];

    const data = applyFieldMapping(payload, fields);
    const withRules = applyRules(data, payload, [
      { field: 'available', op: 'gt', column: 'stock', value: 0 },
    ]);

    expect(withRules.available).toBe(true);
    expect(buildSearchSource(withRules, fields)).toBe('Camiseta');
  });

  it('aplica reglas compuestas con conditions AND', () => {
    const payload = { status: 'active', inventoryQuantity: 4 };
    const result = applyRules({}, payload, [
      {
        field: 'available',
        conditions: [
          { column: 'status', op: 'eq', value: 'active' },
          { column: 'inventoryQuantity', op: 'gt', value: 0 },
        ],
      },
    ]);
    expect(result.available).toBe(true);
  });

  it('renders embedding template', () => {
    const text = renderTemplate('{{name}} - {{sku}}', { name: 'A', sku: 'SKU-1' }, [
      'name',
      'sku',
    ]);
    expect(text).toBe('A - SKU-1');
  });

  it('extrae valores desde columnas JSON con jsonPath', () => {
    const data = applyFieldMapping(
      {
        atributos: {
          litros: 1100,
          material: 'Polietileno tricapa',
        },
      },
      [
        {
          name: 'capacity_liters',
          sourceColumn: 'atributos',
          jsonPath: '$.litros',
          type: 'number',
          searchable: false,
          filterable: true,
          visible: true,
          sensitive: false,
        },
        {
          name: 'material',
          sourceColumn: 'atributos',
          jsonPath: '$.material',
          type: 'string',
          searchable: true,
          filterable: true,
          visible: true,
          sensitive: false,
        },
      ],
    );

    expect(data).toMatchObject({
      capacity_liters: 1100,
      material: 'Polietileno tricapa',
    });
  });

  it('no incluye campos sensitive en search source aunque estén marcados searchable', () => {
    const text = buildSearchSource(
      { name: 'Producto', cost: 12.5 },
      [
        {
          name: 'name',
          sourceColumn: 'name',
          type: 'string',
          searchable: true,
          filterable: false,
          visible: true,
          sensitive: false,
        },
        {
          name: 'cost',
          sourceColumn: 'cost',
          type: 'number',
          searchable: true,
          filterable: false,
          visible: false,
          sensitive: true,
        },
      ],
    );
    expect(text).toBe('Producto');
  });

  it('canonicaliza cardinality many desde CSV y array', () => {
    const fields = [
      {
        name: 'collections',
        sourceColumn: 'collections',
        type: 'json' as const,
        searchable: true,
        filterable: true,
        visible: true,
        sensitive: false,
        retrieval: {
          cardinality: 'many' as const,
          match: 'contains' as const,
          inferredBehavior: 'prefer' as const,
          boost: 0.3,
          searchWeight: 'B' as const,
        },
      },
    ];

    expect(
      applyFieldMapping({ collections: 'Verano, Ofertas' }, fields).collections,
    ).toEqual(['Verano', 'Ofertas']);
    expect(
      applyFieldMapping({ collections: ['Verano', 'Ofertas'] }, fields).collections,
    ).toEqual(['Verano', 'Ofertas']);
  });
});

import { describe, expect, it } from 'vitest';
import type { MappingEntity } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import { compileToolsForEntity, mergeToolDefinitions, slugifyToolName } from './compiler.js';

const variantEntity: MappingEntity = {
  entity: 'variant',
  description: 'Variantes de producto Shopify',
  sourceTable: 'variants',
  fields: [
    {
      name: 'sku',
      sourceColumn: 'sku',
      type: 'string',
      description: 'SKU de la variante',
      label: 'SKU',
      filterLabel: 'SKU',
      aliases: ['codigo', 'código'],
      identifier: true,
      searchable: true,
      filterable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'price',
      sourceColumn: 'price',
      type: 'number',
      label: 'Precio',
      filterLabel: 'precio de venta',
      unit: 'MXN',
      aliases: [],
      identifier: false,
      searchable: false,
      filterable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'color',
      sourceColumn: 'color',
      type: 'string',
      label: 'Color',
      filterLabel: 'color',
      aliases: [],
      identifier: false,
      searchable: false,
      filterable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'cost',
      sourceColumn: 'unitCost',
      type: 'number',
      aliases: [],
      identifier: false,
      searchable: false,
      filterable: false,
      visible: true,
      sensitive: true,
    },
  ],
  rules: [
    {
      field: 'available',
      label: 'Disponible',
      description: 'Producto activo con inventario',
      aliases: ['disponible', 'en stock'],
      conditions: [
        { column: 'status', op: 'eq', value: 'active' },
        { column: 'inventoryQuantity', op: 'gt', value: 0 },
      ],
    },
  ],
  defaultFilters: [{ field: 'available', op: 'eq', value: true }],
  embeddingTextTemplate: '{{sku}} {{color}}',
};

const profile: SourceProfileDocument = {
  totalRecords: 10,
  profiledAt: new Date().toISOString(),
  tables: [
    {
      table: 'variants',
      recordCount: 10,
      columns: [
        {
          name: 'sku',
          inferredType: 'string',
          cardinality: 10,
          nullCount: 0,
          nullRate: 0,
          topValues: [],
        },
        {
          name: 'price',
          inferredType: 'number',
          cardinality: 8,
          nullCount: 0,
          nullRate: 0,
          topValues: [],
          min: 10,
          max: 500,
        },
        {
          name: 'color',
          inferredType: 'string',
          cardinality: 3,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: 'rojo', count: 4 },
            { value: 'azul', count: 3 },
            { value: 'negro', count: 3 },
          ],
        },
      ],
    },
  ],
};

describe('tool compiler', () => {
  it('generates search tool with enums and range fields', () => {
    const tools = compileToolsForEntity({
      entity: variantEntity,
      profile,
      mappingVersion: 2,
      sourceIds: ['11111111-1111-4111-8111-111111111111'],
      workspaceName: 'Demo',
    });

    const search = tools.find((tool) => tool.name === 'search_variant');
    expect(search).toBeDefined();
    expect(search?.description).toContain('Variantes de producto Shopify');
    expect(search?.description).toContain('When to use:');
    expect(search?.description).toContain('Never use for:');
    expect(search?.description).toContain('Success criteria:');
    expect(search?.description).toContain('Fallback:');
    expect(search?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });

    const properties = search?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.color?.enum).toEqual(['rojo', 'azul', 'negro']);
    expect(properties.price_min?.minimum).toBe(10);
    expect(properties.price_max?.maximum).toBe(500);
    expect(properties.price_min?.description).toContain('MXN');
    expect(properties.sku?.title).toBe('SKU');
    expect(properties.available?.type).toBe('boolean');
    expect(properties.available?.description).toContain('Producto activo con inventario');
    expect(properties.cost).toBeUndefined();
  });

  it('generates check_availability when boolean filter exists', () => {
    const tools = compileToolsForEntity({
      entity: variantEntity,
      profile,
      mappingVersion: 1,
      sourceIds: ['11111111-1111-4111-8111-111111111111'],
    });

    const availability = tools.find((tool) => tool.name === 'check_availability_variant');
    expect(availability).toBeDefined();
    expect(availability?.description).toContain('When to use:');
    expect(availability?.description).toContain('Never use for:');
    expect(availability?.inputSchema.required).toEqual(['sku']);
    const properties = availability?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.sku?.title).toBe('SKU');
  });

  it('merges sourceIds and compatible schema metadata for duplicate tool names', () => {
    const secondProfile: SourceProfileDocument = {
      ...profile,
      tables: [
        {
          ...profile.tables[0]!,
          columns: profile.tables[0]!.columns.map((column) => {
            if (column.name === 'color') {
              return {
                ...column,
                cardinality: 4,
                topValues: [
                  { value: 'verde', count: 5 },
                  { value: 'negro', count: 2 },
                ],
              };
            }
            if (column.name === 'price') {
              return { ...column, min: 5, max: 750 };
            }
            return column;
          }),
        },
      ],
    };
    const first = compileToolsForEntity({
      entity: variantEntity,
      profile,
      mappingVersion: 1,
      sourceIds: ['11111111-1111-4111-8111-111111111111'],
    });
    const second = compileToolsForEntity({
      entity: variantEntity,
      profile: secondProfile,
      mappingVersion: 3,
      sourceIds: ['22222222-2222-4222-8222-222222222222'],
    });

    const merged = mergeToolDefinitions([...first, ...second]);
    const search = merged.find((tool) => tool.name === 'search_variant');
    expect(search?.sourceIds).toHaveLength(2);
    expect(search?.mappingVersion).toBe(3);
    const properties = search?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.color?.enum).toEqual(['rojo', 'azul', 'negro', 'verde']);
    expect(properties.price_min?.minimum).toBe(5);
    expect(properties.price_max?.maximum).toBe(750);
  });

  it('trunca enums fusionados en vez de borrarlos', () => {
    const values = Array.from({ length: 25 }, (_, index) => ({
      value: `color-${String(index)}`,
      count: 1,
    }));
    const secondProfile: SourceProfileDocument = {
      ...profile,
      tables: [
        {
          ...profile.tables[0]!,
          columns: profile.tables[0]!.columns.map((column) =>
            column.name === 'color'
              ? { ...column, cardinality: 25, suggestedValues: values, topValues: values.slice(0, 20) }
              : column,
          ),
        },
      ],
    };

    const merged = mergeToolDefinitions([
      ...compileToolsForEntity({
        entity: variantEntity,
        profile: secondProfile,
        mappingVersion: 1,
        sourceIds: ['11111111-1111-4111-8111-111111111111'],
      }),
      ...compileToolsForEntity({
        entity: variantEntity,
        profile: secondProfile,
        mappingVersion: 1,
        sourceIds: ['22222222-2222-4222-8222-222222222222'],
      }),
    ]);

    const search = merged.find((tool) => tool.name === 'search_variant');
    const properties = search?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.color?.enum).toHaveLength(20);
    expect(properties.color?.description).toContain('Valores disponibles truncados');
  });

  it('slugifies entity names', () => {
    expect(slugifyToolName('Product Variant')).toBe('product_variant');
  });
});

import { describe, it, expect } from 'vitest';
import type { MappingEntity } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import { extractFilters } from './extract-filters.js';

const baseEntity: MappingEntity = {
  entity: 'product',
  sourceTable: 'products',
  fields: [
    {
      name: 'price',
      sourceColumn: 'price',
      type: 'number',
      label: 'Precio',
      aliases: ['costo'],
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
    {
      name: 'stock',
      sourceColumn: 'stock',
      type: 'number',
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
    {
      name: 'color',
      sourceColumn: 'color',
      type: 'string',
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
    {
      name: 'size',
      sourceColumn: 'size',
      type: 'string',
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
    {
      name: 'category',
      sourceColumn: 'category',
      type: 'string',
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
    {
      name: 'available',
      sourceColumn: 'available',
      type: 'boolean',
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
    {
      name: 'name',
      sourceColumn: 'name',
      type: 'string',
      filterable: false,
      searchable: true,
      visible: true,
      sensitive: false,
    },
  ],
  rules: [],
  defaultFilters: [],
  embeddingTextTemplate: '{{name}}',
};

const profile: SourceProfileDocument = {
  totalRecords: 300,
  profiledAt: new Date().toISOString(),
  tables: [
    {
      table: 'products',
      recordCount: 300,
      columns: [
        {
          name: 'color',
          inferredType: 'string',
          cardinality: 6,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: 'rojo', count: 50 },
            { value: 'azul', count: 50 },
            { value: 'negro', count: 50 },
          ],
        },
        {
          name: 'size',
          inferredType: 'string',
          cardinality: 5,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: 'M', count: 60 },
            { value: 'L', count: 60 },
            { value: 'S', count: 60 },
          ],
        },
        {
          name: 'category',
          inferredType: 'string',
          cardinality: 5,
          nullCount: 0,
          nullRate: 0,
          topValues: [{ value: 'camisetas', count: 60 }],
        },
      ],
    },
  ],
};

const shopifyEntity: MappingEntity = {
  entity: 'variant',
  sourceTable: 'variants',
  fields: [
    {
      name: 'width',
      sourceColumn: 'width',
      type: 'string',
      aliases: ['ancho', 'anchura'],
      filterable: true,
      searchable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'composition',
      sourceColumn: 'composition',
      type: 'string',
      aliases: ['composición', 'composicion', 'material'],
      filterable: true,
      searchable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'fabricType',
      sourceColumn: 'fabricType',
      type: 'string',
      aliases: ['tipo de tela', 'tela'],
      filterable: true,
      searchable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'style',
      sourceColumn: 'style',
      type: 'string',
      aliases: ['estilo'],
      filterable: true,
      searchable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'productType',
      sourceColumn: 'productType',
      type: 'string',
      aliases: ['tipo de producto'],
      filterable: true,
      searchable: true,
      visible: true,
      sensitive: false,
    },
    {
      name: 'available',
      sourceColumn: 'available',
      type: 'boolean',
      aliases: ['disponible', 'en stock', 'agotado', 'sin stock'],
      filterable: true,
      searchable: false,
      visible: true,
      sensitive: false,
    },
  ],
  rules: [],
  defaultFilters: [],
  embeddingTextTemplate: '{{width}} {{composition}} {{fabricType}} {{style}} {{productType}}',
};

const shopifyProfile: SourceProfileDocument = {
  totalRecords: 20,
  profiledAt: new Date().toISOString(),
  tables: [
    {
      table: 'variants',
      recordCount: 20,
      columns: [
        {
          name: 'width',
          inferredType: 'string',
          cardinality: 2,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: '1.50 m', count: 10 },
            { value: '1.40 m', count: 10 },
            { value: '100cm', count: 5 },
          ],
        },
        {
          name: 'composition',
          inferredType: 'string',
          cardinality: 2,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: '100% algodón', count: 10 },
            { value: '70% lino, 30% algodón', count: 10 },
          ],
        },
        {
          name: 'fabricType',
          inferredType: 'string',
          cardinality: 2,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: 'lino', count: 10 },
            { value: 'gabardina', count: 10 },
          ],
        },
        {
          name: 'style',
          inferredType: 'string',
          cardinality: 2,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: 'formal', count: 10 },
            { value: 'casual', count: 10 },
          ],
        },
        {
          name: 'productType',
          inferredType: 'string',
          cardinality: 2,
          nullCount: 0,
          nullRate: 0,
          topValues: [
            { value: 'lino', count: 10 },
            { value: 'mezclilla', count: 10 },
          ],
        },
      ],
    },
  ],
};

function run(query: string) {
  return extractFilters({ query, entity: baseEntity, profile });
}

function runShopify(query: string) {
  return extractFilters({ query, entity: shopifyEntity, profile: shopifyProfile });
}

describe('extractFilters', () => {
  it('extrae menos de con formato $1,500', () => {
    const result = run('vestido menos de $1,500');
    expect(result.filters).toContainEqual({ field: 'price', op: 'lt', value: 1500 });
    expect(result.unresolvedText).toContain('vestido');
  });

  it('extrae máximo con separador español 1.500', () => {
    const result = run('máximo 1.500');
    expect(result.filters).toContainEqual({ field: 'price', op: 'lte', value: 1500 });
  });

  it('extrae entre X y Y', () => {
    const result = run('entre 500 y 900');
    expect(result.filters).toContainEqual({ field: 'price', op: 'gte', value: 500 });
    expect(result.filters).toContainEqual({ field: 'price', op: 'lte', value: 900 });
  });

  it('extrae más de 200', () => {
    const result = run('más de 200');
    expect(result.filters).toContainEqual({ field: 'price', op: 'gt', value: 200 });
  });

  it('extrae hasta 300', () => {
    const result = run('hasta 300');
    expect(result.filters).toContainEqual({ field: 'price', op: 'lte', value: 300 });
  });

  it('extrae desde 100', () => {
    const result = run('desde 100');
    expect(result.filters).toContainEqual({ field: 'price', op: 'gte', value: 100 });
  });

  it('extrae enum color rojo', () => {
    const result = run('camiseta roja color rojo');
    expect(result.filters).toContainEqual({ field: 'color', op: 'eq', value: 'rojo' });
  });

  it('extrae enum size M', () => {
    const result = run('vestido rojo talla M');
    expect(result.filters).toContainEqual({ field: 'size', op: 'eq', value: 'M' });
  });

  it('extrae boolean disponible', () => {
    const result = run('camiseta disponible');
    expect(result.filters).toContainEqual({ field: 'available', op: 'eq', value: true });
  });

  it('extrae boolean en stock', () => {
    const result = run('producto en stock');
    expect(result.filters).toContainEqual({ field: 'available', op: 'eq', value: true });
  });

  it('extrae boolean agotado como false', () => {
    const result = run('producto agotado');
    expect(result.filters).toContainEqual({ field: 'available', op: 'eq', value: false });
  });

  it('combina precio y color en una query', () => {
    const result = run('camiseta rojo menos de 100');
    expect(result.filters).toContainEqual({ field: 'price', op: 'lt', value: 100 });
    expect(result.filters).toContainEqual({ field: 'color', op: 'eq', value: 'rojo' });
    expect(result.unresolvedText).toContain('camiseta');
  });

  it('warns y no aplica rango con campos numéricos ambiguos sin hint', () => {
    const ambiguousEntity: MappingEntity = {
      ...baseEntity,
      fields: [
        ...baseEntity.fields.filter((field) => field.type !== 'number'),
        {
          name: 'stock',
          sourceColumn: 'stock',
          type: 'number',
          filterable: true,
          searchable: false,
          visible: true,
          sensitive: false,
        },
        {
          name: 'units',
          sourceColumn: 'price',
          type: 'number',
          filterable: true,
          searchable: false,
          visible: true,
          sensitive: false,
        },
      ],
    };
    const result = extractFilters({ query: 'menos de 100', entity: ambiguousEntity, profile });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.filters.find((filter) => filter.field === 'stock')).toBeUndefined();
  });

  it('deja texto residual sin filtros', () => {
    const result = run('busco zapatillas cómodas');
    expect(result.filters).toHaveLength(0);
    expect(result.unresolvedText).toBe('busco zapatillas cómodas');
  });

  it('extrae categoría del perfil', () => {
    const result = run('camisetas de algodón');
    expect(result.filters).toContainEqual({ field: 'category', op: 'eq', value: 'camisetas' });
  });

  it('extrae por debajo de', () => {
    const result = run('por debajo de 75');
    expect(result.filters).toContainEqual({ field: 'price', op: 'lt', value: 75 });
  });

  it('usa aliases/descripciones para resolver rangos numéricos', () => {
    const aliasEntity: MappingEntity = {
      ...baseEntity,
      fields: [
        ...baseEntity.fields.filter((field) => field.type !== 'number'),
        {
          name: 'amount',
          sourceColumn: 'price',
          type: 'number',
          label: 'Importe',
          aliases: ['precio', 'costo'],
          filterable: true,
          searchable: false,
          visible: true,
          sensitive: false,
        },
      ],
    };
    const result = extractFilters({ query: 'menos de 100 pesos', entity: aliasEntity, profile });
    expect(result.filters).toContainEqual({ field: 'amount', op: 'lt', value: 100 });
  });

  it('extrae boolean desde rule derivada con aliases', () => {
    const derivedEntity: MappingEntity = {
      ...baseEntity,
      fields: baseEntity.fields.filter((field) => field.name !== 'available'),
      rules: [
        {
          field: 'active_for_sale',
          label: 'Disponible',
          description: 'Producto disponible para venta',
          aliases: ['disponible', 'en stock'],
          conditions: [{ column: 'stock', op: 'gt', value: 0 }],
        },
      ],
      defaultFilters: [{ field: 'active_for_sale', op: 'eq', value: true }],
    };

    const result = extractFilters({
      query: 'tinaco disponible',
      entity: derivedEntity,
      profile,
    });

    expect(result.filters).toContainEqual({ field: 'active_for_sale', op: 'eq', value: true });
  });

  it('extrae ancho como valor real desde alias + valor parcial', () => {
    const result = runShopify('tela ancho 1.50');
    expect(result.filters).toContainEqual({ field: 'width', op: 'eq', value: '1.50 m' });
    expect(result.filters).not.toContainEqual({ field: 'width', op: 'eq', value: 'ancho' });
  });

  it('no toma "100%" como width=100cm en matches implícitos', () => {
    const result = runShopify('algodón 100%');
    expect(result.filters.find((filter) => filter.field === 'width')).toBeUndefined();
    expect(result.matches.find((match) => match.field === 'width')).toBeUndefined();
  });

  it('sí mapea "ancho 100" a width=100cm vía hint explícito', () => {
    const result = runShopify('tela ancho 100');
    expect(result.filters).toContainEqual({ field: 'width', op: 'eq', value: '100cm' });
    expect(result.matches).toContainEqual(
      expect.objectContaining({ field: 'width', origin: 'explicit', value: '100cm' }),
    );
  });

  it('extrae tipo de tela como filtro real desde label + valor', () => {
    const result = runShopify('busco tipo de tela lino');
    expect(result.filters).toContainEqual({ field: 'fabricType', op: 'eq', value: 'lino' });
    expect(result.filters.find((filter) => filter.field === 'productType')).toBeUndefined();
  });

  it('extrae estilo como filtro real desde alias + valor', () => {
    const result = runShopify('quiero cortina estilo formal');
    expect(result.filters).toContainEqual({ field: 'style', op: 'eq', value: 'formal' });
  });

  it('extrae composición usando un valor compatible del profile', () => {
    const result = runShopify('composición algodón');
    expect(result.filters).toContainEqual({
      field: 'composition',
      op: 'eq',
      value: '100% algodón',
    });
  });

  it('evita aplicar filtros ambiguos cuando un token matchea varios campos sin label', () => {
    const result = runShopify('lino');
    expect(result.filters.find((filter) => filter.field === 'fabricType')).toBeUndefined();
    expect(result.filters.find((filter) => filter.field === 'productType')).toBeUndefined();
    expect(result.warnings).toContainEqual(
      'Ambiguous string filter "lino" matched multiple fields; leaving it as free text',
    );
    expect(result.unresolvedText).toBe('lino');
  });

  it('prioriza una preferencia explícita de policy sobre filtros legacy ambiguos', () => {
    const policyEntity: MappingEntity = {
      ...shopifyEntity,
      fields: shopifyEntity.fields.map((field) =>
        field.name === 'fabricType'
          ? {
              ...field,
              retrieval: {
                cardinality: 'one',
                match: 'eq',
                inferredBehavior: 'prefer',
                boost: 0.5,
                searchWeight: 'B',
              },
            }
          : field,
      ),
    };
    const result = extractFilters({
      query: 'lino',
      entity: policyEntity,
      profile: shopifyProfile,
    });

    expect(result.matches).toContainEqual(
      expect.objectContaining({ field: 'fabricType', value: 'lino' }),
    );
    expect(result.matches.some((match) => match.field === 'productType')).toBe(false);
    expect(result.warnings).not.toContainEqual(expect.stringContaining('Ambiguous'));
  });

  it('resuelve valueAliases de policy al valor canónico del profile', () => {
    const result = extractFilters({
      query: 'busco playeras',
      entity: baseEntity,
      profile,
      fieldValueAliases: new Map([
        ['category', { camisetas: ['playeras'] }],
      ]),
    });

    expect(result.filters).toContainEqual({
      field: 'category',
      op: 'eq',
      value: 'camisetas',
    });
  });
});

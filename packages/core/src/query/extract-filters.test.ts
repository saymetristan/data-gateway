import { describe, it, expect } from 'vitest';
import type { MappingEntity } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import { extractFilters } from './extract-filters.js';

const baseEntity: MappingEntity = {
  entity: 'product',
  sourceTable: 'products',
  fields: [
    { name: 'price', sourceColumn: 'price', type: 'number', filterable: true, searchable: false, visible: true, sensitive: false },
    { name: 'stock', sourceColumn: 'stock', type: 'number', filterable: true, searchable: false, visible: true, sensitive: false },
    { name: 'color', sourceColumn: 'color', type: 'string', filterable: true, searchable: false, visible: true, sensitive: false },
    { name: 'size', sourceColumn: 'size', type: 'string', filterable: true, searchable: false, visible: true, sensitive: false },
    { name: 'category', sourceColumn: 'category', type: 'string', filterable: true, searchable: false, visible: true, sensitive: false },
    { name: 'available', sourceColumn: 'available', type: 'boolean', filterable: true, searchable: false, visible: true, sensitive: false },
    { name: 'name', sourceColumn: 'name', type: 'string', filterable: false, searchable: true, visible: true, sensitive: false },
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

function run(query: string) {
  return extractFilters({ query, entity: baseEntity, profile });
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
        { name: 'stock', sourceColumn: 'stock', type: 'number', filterable: true, searchable: false, visible: true, sensitive: false },
        { name: 'units', sourceColumn: 'price', type: 'number', filterable: true, searchable: false, visible: true, sensitive: false },
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
});

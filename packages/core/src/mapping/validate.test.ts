import { describe, it, expect } from 'vitest';
import { validateMappingAgainstProfile } from './validate.js';
import type { MappingDocument } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';

const profile: SourceProfileDocument = {
  totalRecords: 1,
  profiledAt: new Date().toISOString(),
  tables: [
    {
      table: 'products',
      recordCount: 1,
      columns: [
        {
          name: 'sku',
          inferredType: 'string',
          cardinality: 1,
          nullCount: 0,
          nullRate: 0,
          topValues: [],
        },
        {
          name: 'name',
          inferredType: 'string',
          cardinality: 1,
          nullCount: 0,
          nullRate: 0,
          topValues: [],
        },
        {
          name: 'stock',
          inferredType: 'number',
          cardinality: 1,
          nullCount: 0,
          nullRate: 0,
          topValues: [],
        },
      ],
    },
  ],
};

const mapping: MappingDocument = {
  entities: [
    {
      entity: 'product',
      sourceTable: 'products',
      fields: [
        {
          name: 'sku',
          sourceColumn: 'sku',
          type: 'string',
          searchable: true,
          filterable: true,
          visible: true,
          sensitive: false,
        },
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
          name: 'stock',
          sourceColumn: 'stock',
          type: 'number',
          searchable: false,
          filterable: true,
          visible: true,
          sensitive: false,
        },
      ],
      rules: [{ field: 'available', op: 'gt', column: 'stock', value: 0 }],
      defaultFilters: [],
      embeddingTextTemplate: '{{name}} {{sku}}',
    },
  ],
};

describe('validateMappingAgainstProfile', () => {
  it('accepts valid mapping', () => {
    expect(() => validateMappingAgainstProfile(mapping, profile)).not.toThrow();
  });

  it('rejects unknown columns', () => {
    const invalid = structuredClone(mapping);
    const entity = invalid.entities[0];
    const field = entity?.fields[0];
    if (!entity || !field) throw new Error('invalid test fixture');
    field.sourceColumn = 'missing';
    expect(() => validateMappingAgainstProfile(invalid, profile)).toThrow();
  });
});

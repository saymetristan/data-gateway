import { describe, expect, it } from 'vitest';
import type { MappingEntity } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import type { ToolDefinition } from '../schemas/tools.js';
import { toolArgsToQuery } from './args-to-query.js';
import { compileToolsForEntity } from './compiler.js';
import { validateToolArgs } from './validate-args.js';

const searchVariantTool: ToolDefinition = {
  name: 'search_variant',
  kind: 'search',
  description: 'Busca variantes',
  entity: 'variant',
  sourceIds: ['11111111-1111-4111-8111-111111111111'],
  mappingVersion: 4,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'Texto libre de búsqueda',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      collections: {
        type: 'array',
        items: {
          type: 'string',
        },
        title: 'collections',
      },
      prefer_collections: {
        type: 'array',
        items: {
          type: 'string',
        },
        title: 'Preferir collections',
      },
      style: {
        type: 'string',
        enum: ['Liso', 'Estampado'],
      },
    },
    required: [],
  },
};

describe('validateToolArgs', () => {
  it('acepta collections y prefer_collections como arrays', () => {
    const result = validateToolArgs(searchVariantTool, {
      query: 'Raso liso Vestir',
      collections: ['Vestir'],
      prefer_collections: ['Vestir'],
      limit: 5,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.collections).toEqual(['Vestir']);
    expect(result.data.prefer_collections).toEqual(['Vestir']);
    expect(result.data.limit).toBe(5);
  });

  it('rechaza scalar cuando el contrato exige array', () => {
    const result = validateToolArgs(searchVariantTool, {
      collections: 'Vestir',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('array');
  });

  it('rechaza miembros de tipo incorrecto en arrays', () => {
    const result = validateToolArgs(searchVariantTool, {
      collections: [123],
    });

    expect(result.success).toBe(false);
  });

  it('rechaza propiedades desconocidas', () => {
    const result = validateToolArgs(searchVariantTool, {
      query: 'raso',
      unknown_field: true,
    });

    expect(result.success).toBe(false);
  });

  it('sigue validando enums escalares', () => {
    const ok = validateToolArgs(searchVariantTool, { style: 'Liso' });
    expect(ok.success).toBe(true);

    const bad = validateToolArgs(searchVariantTool, { style: 'Rayas' });
    expect(bad.success).toBe(false);
  });

  it('acepta arrays generados por el compiler y los traduce a containsAny/preferencia', () => {
    const entity: MappingEntity = {
      entity: 'variant',
      description: 'Variantes',
      sourceTable: 'variants',
      fields: [
        {
          name: 'sku',
          sourceColumn: 'sku',
          type: 'string',
          aliases: [],
          identifier: true,
          searchable: true,
          filterable: true,
          visible: true,
          sensitive: false,
        },
        {
          name: 'collections',
          sourceColumn: 'collections',
          type: 'json',
          aliases: [],
          identifier: false,
          searchable: true,
          filterable: true,
          visible: true,
          sensitive: false,
          retrieval: {
            cardinality: 'many',
            match: 'contains',
            inferredBehavior: 'prefer',
            boost: 0.3,
          },
        },
      ],
      rules: [],
      defaultFilters: [],
      embeddingTextTemplate: '{{sku}}',
    };
    const profile: SourceProfileDocument = {
      totalRecords: 1,
      profiledAt: new Date().toISOString(),
      tables: [
        {
          table: 'variants',
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
              name: 'collections',
              inferredType: 'json',
              cardinality: 3,
              nullCount: 0,
              nullRate: 0,
              topValues: [],
            },
          ],
        },
      ],
    };

    const tools = compileToolsForEntity({
      entity,
      profile,
      mappingVersion: 1,
      sourceIds: ['11111111-1111-4111-8111-111111111111'],
    });
    const search = tools.find((tool) => tool.name === 'search_variant');
    expect(search).toBeDefined();

    const validation = validateToolArgs(search!, {
      query: 'Raso liso Vestir',
      collections: ['Vestir'],
      prefer_collections: ['Vestir'],
    });
    expect(validation.success).toBe(true);
    if (!validation.success) return;

    const translated = toolArgsToQuery(search!, validation.data);
    expect(translated.presetFilters).toEqual([
      { field: 'collections', op: 'containsAny', value: ['Vestir'] },
    ]);
    expect(translated.request.preferences).toEqual([
      { field: 'collections', op: 'contains', value: ['Vestir'], boost: 0.3 },
    ]);
  });
});

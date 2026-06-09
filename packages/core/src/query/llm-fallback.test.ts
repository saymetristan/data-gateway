import { describe, it, expect } from 'vitest';
import type { MappingEntity } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import type { LlmProvider } from '../providers/llm.js';
import { extractFiltersWithLlm } from './llm-fallback.js';

class InvalidFieldLlmProvider implements LlmProvider {
  readonly model = 'invalid-llm';

  complete(): Promise<string> {
    return Promise.resolve(
      JSON.stringify({
        filters: {
          color: 'rojo',
          hacker_field: 'x',
        },
      }),
    );
  }
}

const entity: MappingEntity = {
  entity: 'product',
  sourceTable: 'products',
  fields: [
    { name: 'color', sourceColumn: 'color', type: 'string', filterable: true, searchable: false, visible: true, sensitive: false },
  ],
  rules: [],
  defaultFilters: [],
  embeddingTextTemplate: '{{color}}',
};

const profile: SourceProfileDocument = {
  totalRecords: 1,
  profiledAt: new Date().toISOString(),
  tables: [
    {
      table: 'products',
      recordCount: 1,
      columns: [
        {
          name: 'color',
          inferredType: 'string',
          cardinality: 1,
          nullCount: 0,
          nullRate: 0,
          topValues: [{ value: 'rojo', count: 1 }],
        },
      ],
    },
  ],
};

describe('extractFiltersWithLlm', () => {
  it('descarta campos fuera del mapping con warning', async () => {
    const result = await extractFiltersWithLlm({
      unresolvedText: 'algo rojo',
      entity,
      profile,
      existingFilters: [],
      llmProvider: new InvalidFieldLlmProvider(),
    });

    expect(result.filters).toEqual([{ field: 'color', op: 'eq', value: 'rojo' }]);
    expect(result.warnings.some((warning) => warning.includes('hacker_field'))).toBe(true);
  });
});

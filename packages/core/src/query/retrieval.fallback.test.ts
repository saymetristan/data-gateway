import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import { hybridSearch, type HybridSearchInput } from './retrieval.js';

class FailingEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'failing-embedding';
  readonly dimensions = 4;

  embed(): Promise<number[][]> {
    return Promise.reject(new Error('embedding timeout'));
  }
}

function createFakeDb(lexicalIds: string[]) {
  return {
    execute: async () => ({
      rows: lexicalIds.map((id, index) => ({
        id,
        entity: 'product',
        source_id: 'source-1',
        data: { name: `item-${id}` },
        search_source: `item-${id}`,
        rank: 1 - index * 0.1,
        lexical_match: true,
      })),
    }),
  };
}

describe('hybridSearch embedding fallback', () => {
  it('degrades to lexical search when query embedding fails', async () => {
    const input: HybridSearchInput = {
      db: createFakeDb(['rec-1', 'rec-2']) as HybridSearchInput['db'],
      workspaceId: 'ws-1',
      sourceIds: ['source-1'],
      mappingVersionBySource: new Map([['source-1', 1]]),
      embeddingModel: 'failing-embedding',
      filters: [],
      freeText: 'vinipiel tapiceria',
      limit: 5,
      filterableFields: new Set(),
      embeddingProvider: new FailingEmbeddingProvider(),
      embeddingsAvailableBySource: new Map([['source-1', true]]),
    };

    const result = await hybridSearch(input);

    expect(result.queryType).toBe('lexical');
    expect(result.hits.map((hit) => hit.id)).toEqual(['rec-1', 'rec-2']);
    expect(result.warnings).toContain('Query embedding failed; using lexical search only');
  });

  it('degrades to lexical when upstream passes null queryEmbedding', async () => {
    const input: HybridSearchInput = {
      db: createFakeDb(['rec-9']) as HybridSearchInput['db'],
      workspaceId: 'ws-1',
      sourceIds: ['source-1'],
      mappingVersionBySource: new Map([['source-1', 1]]),
      embeddingModel: 'mock-embedding',
      filters: [],
      freeText: 'baby cotton',
      limit: 5,
      filterableFields: new Set(),
      embeddingsAvailableBySource: new Map([['source-1', true]]),
      queryEmbedding: null,
    };

    const result = await hybridSearch(input);

    expect(result.queryType).toBe('lexical');
    expect(result.hits).toHaveLength(1);
    expect(result.warnings).toContain('Query embedding failed; using lexical search only');
  });
});

import { describe, it, expect } from 'vitest';
import { createWorkspaceSchema, createSourceSchema, syncSourceSchema } from '../schemas/index.js';
import { createMappingSchema } from './mapping.js';

describe('schemas', () => {
  it('validates workspace input', () => {
    const parsed = createWorkspaceSchema.safeParse({
      name: 'Demo',
      slug: 'demo-shop',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid slug', () => {
    const parsed = createWorkspaceSchema.safeParse({
      name: 'Demo',
      slug: 'Demo Shop',
    });
    expect(parsed.success).toBe(false);
  });

  it('validates database_url source', () => {
    const parsed = createSourceSchema.safeParse({
      type: 'database_url',
      name: 'External DB',
      config: {
        connectionUrl: 'postgresql://user:pass@localhost:5432/catalog',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates Shopify source with client credentials', () => {
    const parsed = createSourceSchema.safeParse({
      type: 'shopify',
      name: 'Shopify',
      config: {
        shopDomain: 'bayon.myshopify.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects Shopify source without a complete auth method', () => {
    const parsed = createSourceSchema.safeParse({
      type: 'shopify',
      name: 'Shopify',
      config: {
        shopDomain: 'bayon.myshopify.com',
        clientId: 'client-id',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults sync to indexing and supports profile-only sync', () => {
    expect(syncSourceSchema.parse({})).toEqual({ indexAfterSync: true });
    expect(syncSourceSchema.parse({ indexAfterSync: false })).toEqual({
      indexAfterSync: false,
    });
    expect(syncSourceSchema.safeParse({ indexAfterSync: false, unknown: true }).success).toBe(
      false,
    );
  });

  it('rejects sensitive searchable or filterable mapping fields', () => {
    const parsed = createMappingSchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            sourceTable: 'variants',
            fields: [
              {
                name: 'cost',
                sourceColumn: 'cost',
                type: 'number',
                searchable: false,
                filterable: true,
                visible: false,
                sensitive: true,
              },
            ],
            rules: [],
            defaultFilters: [],
            embeddingTextTemplate: '{{cost}}',
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts mapping descriptions on entity and fields', () => {
    const parsed = createMappingSchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            description: 'Variantes de producto',
            sourceTable: 'variants',
            fields: [
              {
                name: 'sku',
                sourceColumn: 'sku',
                type: 'string',
                description: 'SKU',
                searchable: true,
                filterable: true,
                visible: true,
                sensitive: false,
              },
            ],
            rules: [],
            defaultFilters: [],
            embeddingTextTemplate: '{{sku}}',
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects rules that mix conditions and legacy condition shape', () => {
    const parsed = createMappingSchema.safeParse({
      document: {
        entities: [
          {
            entity: 'variant',
            sourceTable: 'variants',
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
            ],
            rules: [
              {
                field: 'available',
                op: 'eq',
                column: 'status',
                value: 'active',
                conditions: [{ column: 'stock', op: 'gt', value: 0 }],
              },
            ],
            defaultFilters: [],
            embeddingTextTemplate: '{{sku}}',
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { queryRequestSchema } from './query.js';

describe('queryRequestSchema', () => {
  it('accepts free-text only', () => {
    const parsed = queryRequestSchema.parse({ query: 'tela azul' });
    expect(parsed.query).toBe('tela azul');
  });

  it('accepts filter-only requests without query', () => {
    const parsed = queryRequestSchema.parse({
      filters: [{ field: 'available', op: 'eq', value: true }],
    });
    expect(parsed.query).toBeUndefined();
    expect(parsed.filters).toHaveLength(1);
  });

  it('accepts preference-only requests', () => {
    const parsed = queryRequestSchema.parse({
      preferences: [{ field: 'collections', op: 'contains', value: 'Verano' }],
    });
    expect(parsed.preferences).toHaveLength(1);
  });

  it('accepts hybrid text + filters', () => {
    const parsed = queryRequestSchema.parse({
      query: 'tela ligera',
      filters: [{ field: 'price', op: 'lte', value: 500 }],
    });
    expect(parsed.query).toBe('tela ligera');
  });

  it('rejects empty payload with no criteria', () => {
    const parsed = queryRequestSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects whitespace-only query without filters', () => {
    const parsed = queryRequestSchema.safeParse({ query: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('still accepts legacy object filters', () => {
    const parsed = queryRequestSchema.parse({
      filters: { available: true, color: 'Azul' },
    });
    expect(parsed.filters).toEqual({ available: true, color: 'Azul' });
  });
});

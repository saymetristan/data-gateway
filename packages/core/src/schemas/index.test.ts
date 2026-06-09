import { describe, it, expect } from 'vitest';
import { createWorkspaceSchema, createSourceSchema } from '../schemas/index.js';

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
});

import { describe, it, expect } from 'vitest';
import { createEvalCaseSchema } from './evals.js';

describe('createEvalCaseSchema', () => {
  it('rechaza cases sin assertions', () => {
    const parsed = createEvalCaseSchema.safeParse({ query: 'test' });
    expect(parsed.success).toBe(false);
  });

  it('acepta expectedExternalIds', () => {
    const parsed = createEvalCaseSchema.safeParse({
      query: 'SKU-1',
      expectedExternalIds: ['1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('acepta assertions negativas de calidad', () => {
    const parsed = createEvalCaseSchema.safeParse({
      query: 'aceite para motocicleta 4 tiempos',
      mustNotAppearInTop: {
        ids: ['05-ADICUTSC', '101-3744', '122724'],
        k: 3,
      },
      maxResultCount: 0,
      maxConfidence: 0.45,
      mustContainFields: ['item_code'],
    });
    expect(parsed.success).toBe(true);
  });
});

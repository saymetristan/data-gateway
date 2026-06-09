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
});

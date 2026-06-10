import { describe, expect, it } from 'vitest';
import { buildCsvFallbackPrimaryKey } from './csv.js';

describe('csv ingestion helpers', () => {
  it('builds stable fallback ids independent of row order', () => {
    const row = { name: 'Camisa', price: '12.50' };

    expect(buildCsvFallbackPrimaryKey(row)).toBe(buildCsvFallbackPrimaryKey({ ...row }));
    expect(buildCsvFallbackPrimaryKey(row)).toMatch(/^row:[a-f0-9]{16}$/);
  });

  it('keeps duplicate SKUs distinct when row content differs', () => {
    const first = buildCsvFallbackPrimaryKey({ sku: 'SKU-1', name: 'Small' });
    const second = buildCsvFallbackPrimaryKey({ sku: 'SKU-1', name: 'Large' });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^SKU-1:[a-f0-9]{16}$/);
  });
});

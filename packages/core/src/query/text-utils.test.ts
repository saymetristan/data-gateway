import { describe, expect, it } from 'vitest';
import {
  extractExplicitIdentifier,
  normalizeIdentifier,
} from './text-utils.js';

describe('extractExplicitIdentifier', () => {
  it.each([
    ['busco la parte 8929690 para un motor', '8929690'],
    ['necesito el SKU FF-213', 'FF-213'],
    ['¿tienen código 6416?', '6416'],
    ['P/N: AB_123.4', 'AB_123.4'],
    ['SKU-00042', 'SKU-00042'],
  ])('extracts an explicitly labelled code from %s', (query, expected) => {
    expect(extractExplicitIdentifier(query)).toBe(expected);
  });

  it.each([
    'camión modelo 2024',
    'menos de 100 pesos',
    'llanta 11R22.5 para tractocamión',
    'quiero cuatro filtros',
  ])('ignores an unlabelled value in %s', (query) => {
    expect(extractExplicitIdentifier(query)).toBeNull();
  });
});

describe('normalizeIdentifier', () => {
  it('normalizes formatting variants to the same lookup key', () => {
    expect(normalizeIdentifier('FF-213')).toBe('ff213');
    expect(normalizeIdentifier('FF_213')).toBe('ff213');
  });
});

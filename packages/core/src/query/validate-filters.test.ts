import { describe, expect, it } from 'vitest';
import { GatewayError } from '../errors/gateway-error.js';
import type { MappingField } from '../schemas/mapping.js';
import { operatorsForField, validateStructuredFilters } from './validate-filters.js';

function field(partial: Partial<MappingField> & Pick<MappingField, 'name' | 'type'>): MappingField {
  return {
    sourceColumn: partial.sourceColumn ?? partial.name,
    searchable: partial.searchable ?? false,
    filterable: partial.filterable ?? true,
    visible: partial.visible ?? true,
    sensitive: partial.sensitive ?? false,
    aliases: partial.aliases ?? [],
    ...partial,
  };
}

function expectIssue(run: () => void, message: RegExp): void {
  try {
    run();
    expect.fail('expected throw');
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.status).toBe(422);
    const details = gatewayError.details as { issues?: Array<{ message: string }> };
    expect(details.issues?.some((issue) => message.test(issue.message))).toBe(true);
  }
}

describe('validateStructuredFilters', () => {
  const fieldsByName = new Map<string, MappingField>([
    ['available', field({ name: 'available', type: 'boolean' })],
    ['price', field({ name: 'price', type: 'number' })],
    ['color', field({ name: 'color', type: 'string' })],
    [
      'collections',
      field({
        name: 'collections',
        type: 'json',
        retrieval: {
          cardinality: 'many',
          match: 'contains',
          inferredBehavior: 'prefer',
          boost: 0.3,
          searchWeight: 'B',
        },
      }),
    ],
    ['cost', field({ name: 'cost', type: 'number', sensitive: true, filterable: false })],
    ['hidden', field({ name: 'hidden', type: 'string', visible: false })],
  ]);
  const filterableFields = new Set(['available', 'price', 'color', 'collections']);
  const preferableFields = new Set(['collections', 'color']);

  it('accepts valid filter-only clauses', () => {
    expect(() =>
      validateStructuredFilters({
        filters: [
          { field: 'available', op: 'eq', value: true },
          { field: 'price', op: 'lte', value: 500 },
          { field: 'collections', op: 'contains', value: 'Verano' },
        ],
        fieldsByName,
        filterableFields,
      }),
    ).not.toThrow();
  });

  it('rejects unknown fields with 422', () => {
    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [{ field: 'unknown', op: 'eq', value: 'x' }],
          fieldsByName,
          filterableFields,
        }),
      /Unknown field/,
    );
  });

  it('rejects sensitive and non-visible fields', () => {
    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [{ field: 'cost', op: 'eq', value: 10 }],
          fieldsByName,
          filterableFields: new Set(['cost']),
        }),
      /sensitive/,
    );

    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [{ field: 'hidden', op: 'eq', value: 'x' }],
          fieldsByName,
          filterableFields: new Set(['hidden']),
        }),
      /not visible/,
    );
  });

  it('rejects operator/type mismatches', () => {
    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [{ field: 'available', op: 'gt', value: true }],
          fieldsByName,
          filterableFields,
        }),
      /only valid for number\/date/,
    );

    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [{ field: 'color', op: 'containsAny', value: ['Azul'] }],
          fieldsByName,
          filterableFields,
        }),
      /multi-value/,
    );
  });

  it('rejects default-filter overrides', () => {
    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [{ field: 'available', op: 'eq', value: false }],
          fieldsByName,
          filterableFields,
          defaultFilters: [{ field: 'available', op: 'eq', value: true }],
        }),
      /default filter/,
    );
  });

  it('rejects invalid preference fields when strict', () => {
    expectIssue(
      () =>
        validateStructuredFilters({
          filters: [],
          preferences: [{ field: 'price', op: 'eq', value: 10 }],
          fieldsByName,
          filterableFields,
          preferableFields,
          strictPreferences: true,
        }),
      /not preferable/,
    );
  });

  it('lists operators for field types', () => {
    expect(operatorsForField(fieldsByName.get('price')!)).toEqual(
      expect.arrayContaining(['eq', 'gt', 'lte', 'in']),
    );
    expect(operatorsForField(fieldsByName.get('collections')!)).toEqual(
      expect.arrayContaining(['contains', 'containsAny', 'containsAll']),
    );
    expect(operatorsForField(fieldsByName.get('available')!)).toEqual(['eq', 'neq']);
  });
});

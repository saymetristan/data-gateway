import { describe, expect, it } from 'vitest';
import { resolveExtractedMatches, type ExtractedFieldMatch } from './extract-filters.js';
import type { MappingField } from '../schemas/mapping.js';

describe('resolveExtractedMatches', () => {
  const fields = new Map<string, MappingField>([
    [
      'collections',
      {
        name: 'collections',
        sourceColumn: 'collections',
        type: 'json',
        searchable: true,
        filterable: true,
        visible: true,
        sensitive: false,
        retrieval: {
          cardinality: 'many',
          match: 'contains',
          inferredBehavior: 'prefer',
          boost: 0.3,
          searchWeight: 'B',
        },
      },
    ],
    [
      'status',
      {
        name: 'status',
        sourceColumn: 'status',
        type: 'string',
        searchable: false,
        filterable: true,
        visible: true,
        sensitive: false,
        retrieval: {
          cardinality: 'one',
          match: 'eq',
          inferredBehavior: 'filter',
          boost: 0.2,
          searchWeight: 'D',
        },
      },
    ],
    [
      'brand',
      {
        name: 'brand',
        sourceColumn: 'brand',
        type: 'string',
        searchable: true,
        filterable: true,
        visible: true,
        sensitive: false,
        retrieval: {
          cardinality: 'one',
          match: 'eq',
          inferredBehavior: 'search',
          boost: 0,
          searchWeight: 'C',
        },
      },
    ],
  ]);

  it('routes implicit matches according to mapping policy and keeps explicit hard', () => {
    const matches: ExtractedFieldMatch[] = [
      {
        field: 'collections',
        op: 'contains',
        value: 'Verano',
        origin: 'implicit',
        span: { start: 0, end: 16 },
      },
      {
        field: 'status',
        op: 'eq',
        value: 'active',
        origin: 'explicit',
        span: { start: 17, end: 30 },
      },
      {
        field: 'brand',
        op: 'eq',
        value: 'Acme',
        origin: 'implicit',
        span: { start: 31, end: 35 },
      },
    ];

    const resolved = resolveExtractedMatches({
      query: 'colección Verano status active Acme',
      matches,
      fieldsByName: fields,
    });

    expect(resolved.filters).toEqual([
      { field: 'status', op: 'eq', value: 'active', origin: 'explicit' },
    ]);
    expect(resolved.preferences[0]).toMatchObject({
      field: 'collections',
      op: 'contains',
      value: 'Verano',
      boost: 0.3,
    });
    // brand inferredBehavior=search keeps text in free query
    expect(resolved.unresolvedText.toLowerCase()).toContain('acme');
    expect(resolved.filters.some((filter) => filter.field === 'brand')).toBe(false);
    expect(resolved.preferences.some((pref) => pref.field === 'brand')).toBe(false);
  });

  it('keeps explicit hints as hard filters even when inferred behavior is prefer', () => {
    const resolved = resolveExtractedMatches({
      query: 'colección Verano',
      matches: [
        {
          field: 'collections',
          op: 'contains',
          value: 'Verano',
          origin: 'explicit',
          span: { start: 0, end: 18 },
        },
      ],
      fieldsByName: fields,
    });

    expect(resolved.filters).toEqual([
      {
        field: 'collections',
        op: 'contains',
        value: 'Verano',
        origin: 'explicit',
      },
    ]);
    expect(resolved.preferences).toEqual([]);
  });
});

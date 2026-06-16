import type { MappingEntity } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import type { NormalizedFilter } from '../schemas/query.js';
import type { FilterableTarget } from '../mapping/metadata.js';
import { getFilterableTargets, profileColumnsForEntity } from '../mapping/metadata.js';
import { escapeRegex, normalizeText, parseSpanishNumber } from './text-utils.js';

export type ExtractFiltersInput = {
  query: string;
  entity: MappingEntity;
  profile: SourceProfileDocument;
};

export type ExtractFiltersResult = {
  filters: NormalizedFilter[];
  unresolvedText: string;
  warnings: string[];
};

const BOOLEAN_TRUE_PHRASES = [
  'disponible',
  'en stock',
  'in stock',
  'available',
  'hay stock',
];

const BOOLEAN_FALSE_PHRASES = [
  'agotado',
  'sin stock',
  'no disponible',
  'out of stock',
];

const PRICE_FIELD_HINTS = ['price', 'precio', 'cost', 'coste', 'costo', 'amount', 'monto'];

type NumericRangeMatch = {
  op: 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
  span: { start: number; end: number };
};

export function extractFilters(input: ExtractFiltersInput): ExtractFiltersResult {
  const warnings: string[] = [];
  const filters: NormalizedFilter[] = [];
  const consumed: Array<{ start: number; end: number }> = [];

  const filterableFields = getFilterableTargets(input.entity);
  const profileColumns = profileColumnsForEntity(input.entity, input.profile);
  const numericFields = filterableFields.filter((field) => field.type === 'number');

  if (numericFields.length > 0) {
    const target = resolveNumericField(numericFields, warnings);
    if (target) {
      const numeric = extractNumericRanges(input.query);
      for (const match of numeric) {
        filters.push({ field: target.name, op: match.op, value: match.value });
        consumed.push(match.span);
      }
    }
  }

  for (const field of filterableFields) {
    if (field.type === 'string') {
      const column = field.sourceColumn
        ? profileColumns.get(field.sourceColumn)
        : profileColumns.get(field.name);
      const enumMatch = extractEnumFilter(input.query, field, column);
      if (enumMatch) {
        filters.push({ field: field.name, op: 'eq', value: enumMatch.value });
        consumed.push(enumMatch.span);
      }
    }

    if (field.type === 'boolean') {
      const boolMatch = extractBooleanFilter(input.query, field);
      if (boolMatch) {
        filters.push({ field: field.name, op: 'eq', value: boolMatch.value });
        consumed.push(boolMatch.span);
      }
    }
  }

  const unresolvedText = removeConsumedSpans(input.query, consumed);
  return { filters, unresolvedText, warnings };
}

function extractNumericRanges(query: string): NumericRangeMatch[] {
  const matches: NumericRangeMatch[] = [];
  const normalized = normalizeText(query);

  const between = normalized.match(
    /\bentre\s+(\$?\d[\d.,]*)\s+y\s+(\$?\d[\d.,]*)\b/i,
  );
  if (between?.[1] && between[2]) {
    const low = parseSpanishNumber(between[1]);
    const high = parseSpanishNumber(between[2]);
    if (low !== null && high !== null) {
      const span = findSpan(query, between[0]);
      matches.push(
        { op: 'gte', value: Math.min(low, high), span },
        { op: 'lte', value: Math.max(low, high), span },
      );
      return matches;
    }
  }

  const patterns: Array<{ regex: RegExp; op: NumericRangeMatch['op'] }> = [
    { regex: /\b(?:menos de|menor que|por debajo de|under|below)\s+(\$?\d[\d.,]*)\b/gi, op: 'lt' },
    { regex: /\b(?:mas de|más de|mayor que|por encima de|over|above)\s+(\$?\d[\d.,]*)\b/gi, op: 'gt' },
    { regex: /\b(?:maximo|máximo|hasta|up to|max)\s+(\$?\d[\d.,]*)\b/gi, op: 'lte' },
    { regex: /\b(?:minimo|mínimo|desde|from|min)\s+(\$?\d[\d.,]*)\b/gi, op: 'gte' },
  ];

  for (const pattern of patterns) {
    const match = pattern.regex.exec(normalized);
    if (!match?.[1]) continue;
    const value = parseSpanishNumber(match[1]);
    if (value === null) continue;
    matches.push({
      op: pattern.op,
      value,
      span: findSpan(query, match[0]),
    });
    break;
  }

  return matches;
}

function resolveNumericField(
  candidates: FilterableTarget[],
  warnings: string[],
): FilterableTarget | null {
  const hinted = candidates.filter((item) =>
    PRICE_FIELD_HINTS.some((hint) =>
      [
        item.name,
        item.label,
        item.filterLabel,
        item.description ?? '',
        ...item.aliases,
      ].some((value) => value.toLowerCase().includes(hint)),
    ),
  );

  if (hinted.length === 1) {
    return hinted[0] ?? null;
  }

  if (hinted.length > 1) {
    warnings.push('Ambiguous numeric filter fields; numeric range not applied');
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  if (candidates.length > 1) {
    warnings.push('Ambiguous numeric filter fields; numeric range not applied');
    return null;
  }

  return null;
}

function extractEnumFilter(
  query: string,
  field: FilterableTarget,
  column: ProfileColumn | undefined,
): { value: string; span: { start: number; end: number } } | null {
  const values = column?.suggestedValues ?? column?.topValues ?? [];
  if (values.length === 0 && field.aliases.length === 0) return null;

  const normalizedQuery = normalizeText(query);
  let best:
    | { value: string; span: { start: number; end: number }; length: number }
    | null = null;

  for (const topValue of values) {
    if (topValue.value === null) continue;
    const token = normalizeText(String(topValue.value));
    if (token.length < 1) continue;

    const regex = new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`, 'i');
    const match = regex.exec(normalizedQuery);
    if (!match) continue;

    const span = findSpan(query, String(topValue.value));
    if (!best || token.length > best.length) {
      best = { value: String(topValue.value), span, length: token.length };
    }
  }

  for (const alias of field.aliases) {
    const token = normalizeText(alias);
    const regex = new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`, 'i');
    const match = regex.exec(normalizedQuery);
    if (!match) continue;
    if (!best || token.length > best.length) {
      best = { value: alias, span: findSpan(query, alias), length: token.length };
    }
  }

  return best ? { value: best.value, span: best.span } : null;
}

function extractBooleanFilter(
  query: string,
  field: FilterableTarget,
): { value: boolean; span: { start: number; end: number } } | null {
  const normalized = normalizeText(query);
  const hintText = [
    field.name,
    field.label,
    field.filterLabel,
    field.description ?? '',
    ...field.aliases,
  ].join(' ').toLowerCase();
  const nameHint =
    hintText.includes('available') ||
    hintText.includes('disponible') ||
    hintText.includes('disponibilidad') ||
    hintText.includes('stock') ||
    hintText.includes('activo') ||
    hintText.includes('active');

  if (!nameHint && field.name !== 'available') {
    return null;
  }

  for (const phrase of BOOLEAN_TRUE_PHRASES) {
    const idx = normalized.indexOf(phrase);
    if (idx >= 0) {
      return { value: true, span: findSpan(query, phrase) };
    }
  }

  for (const phrase of BOOLEAN_FALSE_PHRASES) {
    const idx = normalized.indexOf(phrase);
    if (idx >= 0) {
      return { value: false, span: findSpan(query, phrase) };
    }
  }

  return null;
}

function findSpan(original: string, matchedText: string): { start: number; end: number } {
  const direct = original.toLowerCase().indexOf(matchedText.toLowerCase());
  if (direct >= 0) {
    return { start: direct, end: direct + matchedText.length };
  }
  return { start: 0, end: matchedText.length };
}

function removeConsumedSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  if (spans.length === 0) return text.trim();

  const mask = new Array<boolean>(text.length).fill(false);
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < mask.length; i++) {
      mask[i] = true;
    }
  }

  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (!mask[i]) result += text[i] ?? '';
  }

  return result.replace(/\s+/g, ' ').trim();
}

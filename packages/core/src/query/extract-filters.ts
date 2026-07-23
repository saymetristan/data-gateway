import type { MappingEntity, MappingField } from '../schemas/mapping.js';
import { getFieldRetrieval } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import type { FilterOp, NormalizedFilter, QueryPreference } from '../schemas/query.js';
import type { FilterableTarget } from '../mapping/metadata.js';
import { getFilterableTargets, profileColumnsForEntity } from '../mapping/metadata.js';
import { escapeRegex, normalizeText, parseSpanishNumber } from './text-utils.js';

export type ExtractFiltersInput = {
  query: string;
  entity: MappingEntity;
  profile: SourceProfileDocument;
};

export type ExtractedFieldMatch = {
  field: string;
  op: FilterOp;
  value: string | number | boolean | Array<string | number | boolean>;
  origin: 'explicit' | 'implicit';
  span: { start: number; end: number };
};

export type ExtractFiltersResult = {
  /** @deprecated Prefer `matches` + resolveExtractedMatches */
  filters: NormalizedFilter[];
  matches: ExtractedFieldMatch[];
  unresolvedText: string;
  warnings: string[];
};

export type ResolvedFilter = NormalizedFilter & {
  origin: 'explicit' | 'implicit';
};

export type ResolveMatchesResult = {
  filters: ResolvedFilter[];
  preferences: QueryPreference[];
  unresolvedText: string;
  warnings: string[];
};

const BOOLEAN_TRUE_PHRASES = ['disponible', 'en stock', 'in stock', 'available', 'hay stock'];

const BOOLEAN_FALSE_PHRASES = ['agotado', 'sin stock', 'no disponible', 'out of stock'];

const PRICE_FIELD_HINTS = ['price', 'precio', 'cost', 'coste', 'costo', 'amount', 'monto'];

type NumericRangeMatch = {
  op: 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
  span: { start: number; end: number };
};

type StringFilterMatch = {
  field: string;
  op: FilterOp;
  value: string;
  span: { start: number; end: number };
  explicit: boolean;
  length: number;
};

export function extractFilters(input: ExtractFiltersInput): ExtractFiltersResult {
  const warnings: string[] = [];
  const matches: ExtractedFieldMatch[] = [];
  const consumed: Array<{ start: number; end: number }> = [];

  const filterableFields = getFilterableTargets(input.entity);
  const profileColumns = profileColumnsForEntity(input.entity, input.profile);
  const numericFields = filterableFields.filter((field) => field.type === 'number');

  if (numericFields.length > 0) {
    const target = resolveNumericField(numericFields, warnings);
    if (target) {
      const numeric = extractNumericRanges(input.query);
      for (const match of numeric) {
        matches.push({
          field: target.name,
          op: match.op,
          value: match.value,
          origin: 'explicit',
          span: match.span,
        });
        consumed.push(match.span);
      }
    }
  }

  const stringMatches: StringFilterMatch[] = [];
  for (const field of filterableFields) {
    if (field.type === 'string' || field.type === 'json') {
      const column = field.sourceColumn
        ? profileColumns.get(field.sourceColumn)
        : profileColumns.get(field.name);
      stringMatches.push(...extractStringFilterMatches(input.query, field, column));
    }

    if (field.type === 'boolean') {
      const boolMatch = extractBooleanFilter(input.query, field);
      if (boolMatch) {
        matches.push({
          field: field.name,
          op: 'eq',
          value: boolMatch.value,
          origin: 'explicit',
          span: boolMatch.span,
        });
        consumed.push(boolMatch.span);
      }
    }
  }

  const selectedStringMatches = selectStringFilterMatches(stringMatches, warnings);
  for (const match of selectedStringMatches) {
    matches.push({
      field: match.field,
      op: match.op,
      value: match.value,
      origin: match.explicit ? 'explicit' : 'implicit',
      span: match.span,
    });
    consumed.push(match.span);
  }

  const filters: NormalizedFilter[] = matches.map((match) => ({
    field: match.field,
    op: match.op,
    value: match.value,
  }));

  const unresolvedText = removeConsumedSpans(input.query, consumed);
  return { filters, matches, unresolvedText, warnings };
}

/**
 * Convert NL matches into hard filters / soft preferences according to mapping policy.
 * `search` keeps the matched span in free text.
 */
export function resolveExtractedMatches(input: {
  query: string;
  matches: ExtractedFieldMatch[];
  fieldsByName: Map<string, MappingField>;
  extraWarnings?: string[];
  resolveBehavior?: (
    field: string,
    origin: 'explicit' | 'implicit',
  ) => 'filter' | 'prefer' | 'search';
  resolveBoost?: (field: string) => number | undefined;
}): ResolveMatchesResult {
  const warnings = [...(input.extraWarnings ?? [])];
  const filters: ResolvedFilter[] = [];
  const preferences: QueryPreference[] = [];
  const consumed: Array<{ start: number; end: number }> = [];

  for (const match of input.matches) {
    const field = input.fieldsByName.get(match.field);
    const retrieval = field ? getFieldRetrieval(field) : undefined;
    // Mapping/policy only controls inferred values. Explicit field hints such as
    // "color blanco" are user constraints and must remain hard filters.
    const behavior =
      input.resolveBehavior?.(match.field, match.origin) ??
      (match.origin === 'explicit' ? 'filter' : (retrieval?.inferredBehavior ?? 'filter'));
    const op = match.op;
    const boost = input.resolveBoost?.(match.field) ?? retrieval?.boost;

    if (behavior === 'search') {
      continue;
    }

    if (behavior === 'prefer') {
      preferences.push({
        field: match.field,
        op,
        value: match.value,
        ...(boost !== undefined ? { boost } : {}),
      });
      consumed.push(match.span);
      continue;
    }

    filters.push({
      field: match.field,
      op,
      value: match.value,
      origin: match.origin,
    });
    consumed.push(match.span);
  }

  return {
    filters,
    preferences,
    unresolvedText: removeConsumedSpans(input.query, consumed),
    warnings,
  };
}

function defaultMatchOp(field: FilterableTarget): FilterOp {
  const match = field.retrieval?.match;
  if (match === 'contains' || match === 'containsAny' || match === 'containsAll') {
    return match;
  }
  if (field.retrieval?.cardinality === 'many') return 'contains';
  return 'eq';
}

function extractNumericRanges(query: string): NumericRangeMatch[] {
  const matches: NumericRangeMatch[] = [];
  const normalized = normalizeText(query);

  const between = normalized.match(/\bentre\s+(\$?\d[\d.,]*)\s+y\s+(\$?\d[\d.,]*)\b/i);
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
    {
      regex: /\b(?:mas de|más de|mayor que|por encima de|over|above)\s+(\$?\d[\d.,]*)\b/gi,
      op: 'gt',
    },
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
      [item.name, item.label, item.filterLabel, item.description ?? '', ...item.aliases].some(
        (value) => value.toLowerCase().includes(hint),
      ),
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

function extractStringFilterMatches(
  query: string,
  field: FilterableTarget,
  column: ProfileColumn | undefined,
): StringFilterMatch[] {
  const atomic =
    field.retrieval?.cardinality === 'many' && column?.atomicValues
      ? column.atomicValues.map((item) => String(item.value))
      : null;
  const values = column?.suggestedValues ?? column?.topValues ?? [];
  const stringValues = values
    .map((item) => item.value)
    .filter((value) => value !== null)
    .map((value) => String(value));

  // Prefer profiled atomic members for multi-value fields; fall back to CSV split.
  const expandedValues =
    atomic && atomic.length > 0
      ? [...new Set(atomic)]
      : field.retrieval?.cardinality === 'many'
        ? [
            ...new Set(
              stringValues.flatMap((value) =>
                value.includes(',')
                  ? value.split(',').map((part) => part.trim()).filter(Boolean)
                  : [value],
              ),
            ),
          ]
        : stringValues;

  const matches: StringFilterMatch[] = [];
  const normalizedQuery = normalizeText(query);
  const hintSpans = findFieldHintSpans(query, field);
  const op = defaultMatchOp(field);

  for (const hintSpan of hintSpans) {
    const explicit = extractExplicitStringMatch(
      query,
      hintSpan,
      field.name,
      expandedValues,
      op,
    );
    if (explicit) matches.push(explicit);
  }

  for (const value of expandedValues) {
    const valueMatch = findValueMatch(normalizedQuery, value);
    if (!valueMatch) continue;

    matches.push({
      field: field.name,
      op,
      value,
      span: valueMatch.span,
      explicit: false,
      length: valueMatch.length,
    });
  }

  return matches;
}

function extractExplicitStringMatch(
  query: string,
  hintSpan: { start: number; end: number },
  field: string,
  values: string[],
  op: FilterOp,
): StringFilterMatch | null {
  const tail = query.slice(hintSpan.end, Math.min(query.length, hintSpan.end + 80));
  const normalizedTail = normalizeText(tail).replace(/^(?:\s|de|del|la|el|con|en|:|-)+/i, '');
  if (!normalizedTail) return null;

  let best: { value: string; valueSpan: { start: number; end: number }; length: number } | null =
    null;

  for (const value of values) {
    // Explicit (hinted) matches may use numeric aliases: "ancho 100" → "100cm".
    const valueMatch = findValueMatch(normalizedTail, value, { allowNumericAlias: true });
    if (valueMatch) {
      const valueStart = hintSpan.end + valueMatch.span.start;
      const candidate = {
        value,
        valueSpan: { start: valueStart, end: hintSpan.end + valueMatch.span.end },
        length: valueMatch.length,
      };
      if (!best || candidate.length > best.length) best = candidate;
      continue;
    }

    const partial = firstMeaningfulTailToken(normalizedTail);
    const normalizedValue = normalizeText(value);
    if (partial && normalizedValue.includes(partial)) {
      const partialSpan = findNormalizedTokenSpan(normalizedTail, partial);
      const valueStart = hintSpan.end + (partialSpan?.start ?? 0);
      const candidate = {
        value,
        valueSpan: {
          start: valueStart,
          end: hintSpan.end + (partialSpan?.end ?? partial.length),
        },
        length: partial.length,
      };
      if (!best || candidate.length > best.length) best = candidate;
    }
  }

  if (best) {
    return {
      field,
      op,
      value: best.value,
      span: {
        start: Math.min(hintSpan.start, best.valueSpan.start),
        end: Math.max(hintSpan.end, best.valueSpan.end),
      },
      explicit: true,
      length: best.length,
    };
  }

  if (values.length > 0) return null;

  const rawValue = extractRawValueAfterHint(normalizedTail);
  if (!rawValue) return null;
  const rawSpan = findNormalizedTokenSpan(normalizedTail, rawValue) ?? {
    start: 0,
    end: rawValue.length,
  };
  return {
    field,
    op,
    value: rawValue,
    span: { start: hintSpan.start, end: hintSpan.end + rawSpan.end },
    explicit: true,
    length: rawValue.length,
  };
}

function selectStringFilterMatches(
  matches: StringFilterMatch[],
  warnings: string[],
): StringFilterMatch[] {
  const selected: StringFilterMatch[] = [];
  const fields = new Set<string>();

  const explicit = matches
    .filter((match) => match.explicit)
    .sort((left, right) => right.length - left.length);
  for (const match of explicit) {
    if (fields.has(match.field)) continue;
    if (selected.some((item) => spansOverlap(item.span, match.span))) continue;
    selected.push(match);
    fields.add(match.field);
  }

  const implicit = matches.filter((match) => !match.explicit);
  const groups = new Map<string, StringFilterMatch[]>();
  for (const match of implicit) {
    if (fields.has(match.field)) continue;
    if (selected.some((item) => spansOverlap(item.span, match.span))) continue;
    const key = `${String(match.span.start)}:${String(match.span.end)}:${normalizeText(match.value)}`;
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const uniqueFields = new Set(group.map((match) => match.field));
    if (uniqueFields.size > 1) {
      warnings.push(
        `Ambiguous string filter "${first.value}" matched multiple fields; leaving it as free text`,
      );
      continue;
    }
    const match = group.sort((left, right) => right.length - left.length)[0];
    if (!match) continue;
    selected.push(match);
    fields.add(match.field);
  }

  return selected.sort((left, right) => left.span.start - right.span.start);
}

function findFieldHintSpans(
  query: string,
  field: FilterableTarget,
): Array<{ start: number; end: number }> {
  const hints = [field.filterLabel, field.label, field.name, ...field.aliases]
    .filter(Boolean)
    .map((hint) => normalizeText(hint))
    .filter((hint) => hint.length > 1);
  const uniqueHints = [...new Set(hints)].sort((left, right) => right.length - left.length);
  const normalizedQuery = normalizeText(query);
  const spans: Array<{ start: number; end: number }> = [];
  for (const hint of uniqueHints) {
    const span = findNormalizedTokenSpan(normalizedQuery, hint);
    if (!span) continue;
    if (spans.some((item) => spansOverlap(item, span))) continue;
    spans.push(span);
  }
  return spans;
}

function findValueMatch(
  normalizedText: string,
  value: string,
  options?: { allowNumericAlias?: boolean },
): { span: { start: number; end: number }; length: number } | null {
  const tokens = valueTokens(value, options);
  for (const token of tokens) {
    const span = findNormalizedTokenSpan(normalizedText, token);
    if (span) return { span, length: token.length };
  }
  return null;
}

/**
 * Tokens used to match a catalog value against free text.
 * Implicit matches use the full normalized value only — a bare "100" from "100cm"
 * must not match "algodón 100%" (false width filter).
 * Explicit/hinted matches may also use a leading numeric alias ("ancho 100" → "100cm").
 */
function valueTokens(value: string, options?: { allowNumericAlias?: boolean }): string[] {
  const full = normalizeText(value);
  const tokens = [full];
  if (options?.allowNumericAlias) {
    const numeric = full.match(/^\d+(?:[.,]\d+)?/)?.[0];
    if (numeric && numeric.length >= 2) tokens.push(numeric);
  }
  return [...new Set(tokens)]
    .filter((token) => token.length > 0)
    .sort((a, b) => b.length - a.length);
}

function firstMeaningfulTailToken(normalizedTail: string): string | null {
  const tokens = normalizedTail.match(/[a-z0-9%.,]+/g) ?? [];
  const ignored = new Set(['de', 'del', 'la', 'el', 'con', 'en', 'para', 'tipo']);
  const meaningful = tokens.filter((token) => !ignored.has(token));
  return meaningful.slice(0, 3).join(' ') || null;
}

function extractRawValueAfterHint(normalizedTail: string): string | null {
  const match = normalizedTail.match(/[a-z0-9][a-z0-9%.,]*(?:\s+[a-z0-9%.,]+){0,2}/);
  return match?.[0]?.trim() || null;
}

function findNormalizedTokenSpan(
  text: string,
  token: string,
): { start: number; end: number } | null {
  if (!token) return null;
  const regex = new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`, 'i');
  const match = regex.exec(text);
  if (!match) return null;
  const prefixLength = match[1]?.length ?? 0;
  const start = match.index + prefixLength;
  return { start, end: start + token.length };
}

function spansOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
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
  ]
    .join(' ')
    .toLowerCase();
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

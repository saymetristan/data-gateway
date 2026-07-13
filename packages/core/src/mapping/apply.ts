import type {
  MappingEntity,
  MappingField,
  MappingFieldRetrieval,
  MappingRule,
} from '../schemas/mapping.js';
import { getFieldRetrieval } from '../schemas/mapping.js';
import { toScalarString } from '../utils/scalar.js';

export function applyFieldMapping(
  payload: Record<string, unknown>,
  fields: MappingField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = payload[field.sourceColumn];
    const value = field.jsonPath ? readJsonPath(raw, field.jsonPath) : raw;
    result[field.name] = coerceValue(value, field);
  }
  return result;
}

export function applyRules(
  data: Record<string, unknown>,
  payload: Record<string, unknown>,
  rules: MappingRule[],
): Record<string, unknown> {
  const result = { ...data };
  for (const rule of rules) {
    if (rule.conditions?.length) {
      result[rule.field] = rule.conditions.every((condition) =>
        evaluateRule(payload[condition.column], condition.op, condition.value),
      );
      continue;
    }

    if (!rule.op || !rule.column || rule.value === undefined) continue;
    result[rule.field] = evaluateRule(payload[rule.column], rule.op, rule.value);
  }
  return result;
}

function evaluateRule(
  left: unknown,
  op: MappingRule['op'],
  right: string | number | boolean,
): boolean {
  if (left === null || left === undefined) return false;

  switch (op) {
    case 'gt':
      return compareNumbers(left, right, (a, b) => a > b);
    case 'gte':
      return compareNumbers(left, right, (a, b) => a >= b);
    case 'lt':
      return compareNumbers(left, right, (a, b) => a < b);
    case 'lte':
      return compareNumbers(left, right, (a, b) => a <= b);
    case 'eq':
      return left === right || toScalarString(left) === toScalarString(right);
    case 'neq':
      return left !== right && toScalarString(left) !== toScalarString(right);
    default:
      return false;
  }
}

function compareNumbers(
  left: unknown,
  right: string | number | boolean,
  predicate: (left: number, right: number) => boolean,
): boolean {
  const leftNumber = Number(toScalarString(left));
  const rightNumber = Number(right);
  if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) return false;
  return predicate(leftNumber, rightNumber);
}

/**
 * Canonicalize multi-value fields from array, CSV string, or scalar.
 */
export function coerceToStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => toScalarString(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  const scalar = toScalarString(value).trim();
  return scalar ? [scalar] : [];
}

export function buildSearchSource(
  data: Record<string, unknown>,
  fields: MappingField[],
): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (!field.searchable || field.sensitive) continue;
    const value = data[field.name];
    if (value === null || value === undefined) continue;
    const retrieval = getFieldRetrieval(field);
    if (retrieval.cardinality === 'many') {
      parts.push(...coerceToStringArray(value));
    } else {
      parts.push(toScalarString(value));
    }
  }
  return parts.join(' ').trim();
}

/**
 * Build PostgreSQL setweight expression fragments for weighted FTS.
 * Returns map of weight tier -> text content.
 */
export function buildWeightedSearchParts(
  data: Record<string, unknown>,
  fields: MappingField[],
): Record<'A' | 'B' | 'C' | 'D', string> {
  const buckets: Record<'A' | 'B' | 'C' | 'D', string[]> = {
    A: [],
    B: [],
    C: [],
    D: [],
  };

  for (const field of fields) {
    if (!field.searchable || field.sensitive) continue;
    const value = data[field.name];
    if (value === null || value === undefined) continue;
    const retrieval = getFieldRetrieval(field);
    const text =
      retrieval.cardinality === 'many'
        ? coerceToStringArray(value).join(' ')
        : toScalarString(value);
    if (!text.trim()) continue;
    buckets[retrieval.searchWeight].push(text.trim());
  }

  return {
    A: buckets.A.join(' '),
    B: buckets.B.join(' '),
    C: buckets.C.join(' '),
    D: buckets.D.join(' '),
  };
}

export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  allowedFields: string[],
): string {
  const allowed = new Set(allowedFields);
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, fieldName: string) => {
    if (!allowed.has(fieldName)) {
      throw new Error(`Unknown template field: ${fieldName}`);
    }
    const value = data[fieldName];
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return coerceToStringArray(value).join(' ');
    return toScalarString(value);
  });
}

export function renderPromptTemplate(
  template: string,
  data: Record<string, unknown>,
  inputFields: string[],
): string {
  let result = template;
  for (const field of inputFields) {
    const value = data[field];
    const rendered =
      value === undefined
        ? ''
        : Array.isArray(value)
          ? coerceToStringArray(value).join(' ')
          : toScalarString(value);
    result = result.replaceAll(`{{${field}}}`, rendered);
  }
  return result;
}

function coerceValue(value: unknown, field: MappingField): unknown {
  if (value === null || value === undefined) return null;
  const retrieval = getFieldRetrieval(field);

  if (retrieval.cardinality === 'many') {
    return coerceToStringArray(value);
  }

  switch (field.type) {
    case 'number':
      return Number(value);
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return toScalarString(value).toLowerCase() === 'true' || value === 1 || value === '1';
    case 'date':
      return toScalarString(value);
    case 'json':
      return value;
    case 'string':
    default:
      return toScalarString(value);
  }
}

function readJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$.')) return value;
  let current = value;
  for (const segment of path.slice(2).split('.')) {
    if (!segment) continue;
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

export function getExternalId(
  payload: Record<string, unknown>,
  primaryKey: string[],
  fallbackId: string,
): string {
  if (primaryKey.length === 0) return fallbackId;
  const parts = primaryKey.map((key) => toScalarString(payload[key]));
  return parts.join(':');
}

export function parseSourceRecordParts(sourceRecordId: string): {
  table: string;
  externalId: string;
} {
  const separator = sourceRecordId.indexOf(':');
  if (separator === -1) {
    return { table: 'csv', externalId: sourceRecordId };
  }
  return {
    table: sourceRecordId.slice(0, separator),
    externalId: sourceRecordId.slice(separator + 1),
  };
}

export function findEntityForTable(
  entities: MappingEntity[],
  table: string,
): MappingEntity | undefined {
  return entities.find((entity) => entity.sourceTable === table);
}

export function fieldMatchesPreference(
  data: Record<string, unknown>,
  field: string,
  op: string,
  value: string | number | boolean | Array<string | number | boolean>,
  retrieval?: MappingFieldRetrieval,
): boolean {
  const raw = data[field];
  if (raw === null || raw === undefined) return false;

  const cardinality = retrieval?.cardinality ?? (Array.isArray(raw) ? 'many' : 'one');
  const values =
    cardinality === 'many' ? coerceToStringArray(raw) : [toScalarString(raw)];
  const wanted = Array.isArray(value)
    ? value.map((item) => toScalarString(item))
    : [toScalarString(value)];

  switch (op) {
    case 'eq':
      return values.some((item) => wanted.includes(item));
    case 'neq':
      return values.every((item) => !wanted.includes(item));
    case 'in':
    case 'containsAny':
      return values.some((item) => wanted.includes(item));
    case 'contains':
      return wanted.every((item) => values.includes(item));
    case 'containsAll':
      return wanted.every((item) => values.includes(item));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = Number(values[0]);
      const right = Number(wanted[0]);
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      if (op === 'gt') return left > right;
      if (op === 'gte') return left >= right;
      if (op === 'lt') return left < right;
      return left <= right;
    }
    default:
      return false;
  }
}

import type { MappingEntity, MappingField, MappingRule } from '../schemas/mapping.js';
import { toScalarString } from '../utils/scalar.js';

export function applyFieldMapping(
  payload: Record<string, unknown>,
  fields: MappingField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = payload[field.sourceColumn];
    result[field.name] = coerceValue(raw, field.type);
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
    const left = payload[rule.column];
    const right = rule.value;
    result[rule.field] = evaluateRule(left, rule.op, right);
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
      return Number(toScalarString(left)) > Number(right);
    case 'gte':
      return Number(toScalarString(left)) >= Number(right);
    case 'lt':
      return Number(toScalarString(left)) < Number(right);
    case 'lte':
      return Number(toScalarString(left)) <= Number(right);
    case 'eq':
      return left === right || toScalarString(left) === toScalarString(right);
    case 'neq':
      return left !== right && toScalarString(left) !== toScalarString(right);
    default:
      return false;
  }
}

export function buildSearchSource(
  data: Record<string, unknown>,
  fields: MappingField[],
): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (!field.searchable) continue;
    const value = data[field.name];
    if (value === null || value === undefined) continue;
    parts.push(toScalarString(value));
  }
  return parts.join(' ').trim();
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
    return value === null || value === undefined ? '' : toScalarString(value);
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
    result = result.replaceAll(`{{${field}}}`, value === undefined ? '' : toScalarString(value));
  }
  return result;
}

function coerceValue(value: unknown, type: MappingField['type']): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':
      return Number(value);
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return toScalarString(value).toLowerCase() === 'true' || value === 1 || value === '1';
    case 'date':
      return toScalarString(value);
    case 'string':
    default:
      return toScalarString(value);
  }
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

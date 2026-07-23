import { GatewayError } from '../errors/gateway-error.js';
import { getFieldRetrieval, type MappingField } from '../schemas/mapping.js';
import type { FilterOp, NormalizedFilter, QueryPreference } from '../schemas/query.js';

const COMPARISON_OPS = new Set<FilterOp>(['gt', 'gte', 'lt', 'lte']);
const MEMBERSHIP_OPS = new Set<FilterOp>(['in', 'containsAny', 'containsAll']);
const CONTAINS_OPS = new Set<FilterOp>(['contains', 'containsAny', 'containsAll']);

export type StructuredFilterIssue = {
  path: string;
  message: string;
};

export type ValidateStructuredFiltersInput = {
  filters: NormalizedFilter[];
  preferences?: QueryPreference[];
  fieldsByName: Map<string, MappingField>;
  filterableFields: Set<string>;
  preferableFields?: Set<string>;
  defaultFilters?: NormalizedFilter[];
  /** When true, invalid preference fields raise 422 instead of being ignored. */
  strictPreferences?: boolean;
};

/**
 * Validate client-supplied structured filters/preferences.
 * Throws GatewayError.unprocessable (HTTP 422) on the first actionable issue.
 */
export function validateStructuredFilters(input: ValidateStructuredFiltersInput): void {
  const issues: StructuredFilterIssue[] = [];
  const defaultFields = new Set((input.defaultFilters ?? []).map((filter) => filter.field));

  for (let index = 0; index < input.filters.length; index += 1) {
    const filter = input.filters[index];
    if (!filter) continue;
    const path = `filters[${String(index)}]`;
    issues.push(
      ...validateOneClause({
        clause: filter,
        path,
        fieldsByName: input.fieldsByName,
        allowedFields: input.filterableFields,
        defaultFields,
        kind: 'filter',
      }),
    );
  }

  if (input.strictPreferences) {
    for (let index = 0; index < (input.preferences ?? []).length; index += 1) {
      const preference = input.preferences?.[index];
      if (!preference) continue;
      const path = `preferences[${String(index)}]`;
      issues.push(
        ...validateOneClause({
          clause: preference,
          path,
          fieldsByName: input.fieldsByName,
          allowedFields: input.preferableFields ?? input.filterableFields,
          defaultFields,
          kind: 'preference',
        }),
      );
    }
  }

  if (issues.length > 0) {
    throw GatewayError.unprocessable('Invalid structured filters', { issues });
  }
}

function validateOneClause(input: {
  clause: { field: string; op: FilterOp; value: unknown };
  path: string;
  fieldsByName: Map<string, MappingField>;
  allowedFields: Set<string>;
  defaultFields: Set<string>;
  kind: 'filter' | 'preference';
}): StructuredFilterIssue[] {
  const { clause, path, fieldsByName, allowedFields, defaultFields, kind } = input;
  const field = fieldsByName.get(clause.field);

  if (!field) {
    return [{ path: `${path}.field`, message: `Unknown field "${clause.field}"` }];
  }
  if (field.sensitive) {
    return [
      {
        path: `${path}.field`,
        message: `Field "${clause.field}" is sensitive and cannot be used in ${kind}s`,
      },
    ];
  }
  if (!field.visible) {
    return [
      {
        path: `${path}.field`,
        message: `Field "${clause.field}" is not visible and cannot be used in ${kind}s`,
      },
    ];
  }
  if (kind === 'filter' && defaultFields.has(clause.field)) {
    return [
      {
        path: `${path}.field`,
        message: `Field "${clause.field}" is constrained by a default filter and cannot be overridden`,
      },
    ];
  }
  if (!allowedFields.has(clause.field)) {
    return [
      {
        path: `${path}.field`,
        message:
          kind === 'filter'
            ? `Field "${clause.field}" is not filterable`
            : `Field "${clause.field}" is not preferable`,
      },
    ];
  }

  const retrieval = getFieldRetrieval(field);
  const opIssues = validateOperator(clause.op, field, retrieval.cardinality, path);
  if (opIssues.length > 0) return opIssues;

  return validateValue(clause.value, clause.op, field, path);
}

function validateOperator(
  op: FilterOp,
  field: MappingField,
  cardinality: 'one' | 'many',
  path: string,
): StructuredFilterIssue[] {
  if (COMPARISON_OPS.has(op) && field.type !== 'number' && field.type !== 'date') {
    return [
      {
        path: `${path}.op`,
        message: `Operator "${op}" is only valid for number/date fields (got ${field.type})`,
      },
    ];
  }

  if (op === 'in' && field.type === 'boolean') {
    return [
      {
        path: `${path}.op`,
        message: `Operator "in" is not valid for boolean fields`,
      },
    ];
  }

  if (CONTAINS_OPS.has(op) && field.type !== 'string' && field.type !== 'json') {
    return [
      {
        path: `${path}.op`,
        message: `Operator "${op}" is only valid for string/json fields (got ${field.type})`,
      },
    ];
  }

  if (cardinality === 'one' && (op === 'containsAny' || op === 'containsAll')) {
    return [
      {
        path: `${path}.op`,
        message: `Operator "${op}" requires a multi-value field`,
      },
    ];
  }

  return [];
}

function validateValue(
  value: unknown,
  op: FilterOp,
  field: MappingField,
  path: string,
): StructuredFilterIssue[] {
  const expectsArray = MEMBERSHIP_OPS.has(op) || (op === 'contains' && Array.isArray(value));

  if (expectsArray || Array.isArray(value)) {
    if (!Array.isArray(value)) {
      return [
        {
          path: `${path}.value`,
          message: `Operator "${op}" requires an array value`,
        },
      ];
    }
    const items = value as unknown[];
    if (items.length === 0) {
      return [{ path: `${path}.value`, message: 'Array value must not be empty' }];
    }
    for (let index = 0; index < items.length; index += 1) {
      const issue = validateScalar(items[index], field, `${path}.value[${String(index)}]`);
      if (issue) return [issue];
    }
    return [];
  }

  const issue = validateScalar(value, field, `${path}.value`);
  return issue ? [issue] : [];
}

function validateScalar(
  value: unknown,
  field: MappingField,
  path: string,
): StructuredFilterIssue | null {
  if (value === null || value === undefined) {
    return { path, message: 'Value must not be null' };
  }

  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { path, message: `Expected boolean for field "${field.name}"` };
      }
      return null;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return { path, message: `Expected number for field "${field.name}"` };
      }
      return null;
    case 'date':
      if (typeof value !== 'string' || value.trim().length === 0) {
        return { path, message: `Expected date string for field "${field.name}"` };
      }
      return null;
    case 'string':
    case 'json':
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return {
          path,
          message: `Expected scalar string/number/boolean for field "${field.name}"`,
        };
      }
      if (typeof value === 'string' && value.trim().length === 0) {
        return { path, message: 'String value must not be empty' };
      }
      return null;
  }
}

export function operatorsForField(field: MappingField): FilterOp[] {
  const retrieval = getFieldRetrieval(field);
  const ops: FilterOp[] = ['eq', 'neq'];

  if (field.type === 'number' || field.type === 'date') {
    ops.push('gt', 'gte', 'lt', 'lte');
  }
  if (field.type !== 'boolean') {
    ops.push('in');
  }
  if (field.type === 'string' || field.type === 'json') {
    ops.push('contains');
    if (retrieval.cardinality === 'many') {
      ops.push('containsAny', 'containsAll');
    }
  }
  return ops;
}

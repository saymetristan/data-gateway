import type { ColumnType } from './types.js';
import type { DatabaseDialect } from './dialect.js';

const CURSOR_COLUMN_NAMES = ['updated_at', 'modified_at', 'last_modified', 'updated_on'];

export function normalizeColumnType(dataType: string, dialect: DatabaseDialect): ColumnType {
  const type = dataType.toLowerCase();

  if (dialect === 'postgres') {
    if (
      type.includes('int') ||
      type.includes('numeric') ||
      type.includes('decimal') ||
      type.includes('real') ||
      type.includes('double') ||
      type.includes('serial')
    ) {
      return 'number';
    }
    if (type.includes('bool')) return 'boolean';
    if (type === 'date') return 'date';
    if (type.includes('timestamp') || type.includes('time')) return 'datetime';
    if (type.includes('json')) return 'json';
    if (type.includes('char') || type.includes('text') || type.includes('uuid')) return 'string';
    return 'unknown';
  }

  if (
    type.includes('int') ||
    type.includes('decimal') ||
    type.includes('float') ||
    type.includes('double') ||
    type.includes('numeric')
  ) {
    return 'number';
  }
  if (type.includes('bool') || type === 'tinyint(1)') return 'boolean';
  if (type === 'date') return 'date';
  if (type.includes('datetime') || type.includes('timestamp')) return 'datetime';
  if (type.includes('json')) return 'json';
  if (type.includes('char') || type.includes('text') || type.includes('enum')) return 'string';
  return 'unknown';
}

export function detectCursorColumn(columnNames: string[]): string | undefined {
  const lower = new Map(columnNames.map((name) => [name.toLowerCase(), name]));
  for (const candidate of CURSOR_COLUMN_NAMES) {
    const match = lower.get(candidate);
    if (match) return match;
  }
  return undefined;
}

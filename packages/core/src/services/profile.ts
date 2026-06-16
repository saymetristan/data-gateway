import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sourceProfiles, sourceRecordsRaw, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import { maybeTransitionSourceMaturity } from './maturity.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import { toScalarString } from '../utils/scalar.js';

const MAX_PROFILE_ROWS_PER_SOURCE = 10_000;
const MAX_PROFILE_ROWS_PER_TABLE = 10_000;
const MAX_SUGGESTED_VALUES = 50;

export async function profileSource(
  db: Database,
  sourceId: string,
  workspaceId?: string,
): Promise<SourceProfileDocument> {
  const [source] = await db
    .select()
    .from(sources)
    .where(
      workspaceId
        ? and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId))
        : eq(sources.id, sourceId),
    )
    .limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  const rawRows = await db
    .select()
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId))
    .limit(MAX_PROFILE_ROWS_PER_SOURCE * 10);

  const tables = new Map<string, Record<string, unknown>[]>();
  for (const row of rawRows) {
    const payload = row.payload as Record<string, unknown>;
    const tableName =
      typeof payload.__table === 'string'
        ? payload.__table
        : row.sourceRecordId.startsWith('csv:')
          ? 'csv'
          : row.sourceRecordId.split(':')[0] ?? 'unknown';

    const existing = tables.get(tableName) ?? [];
    if (existing.length >= MAX_PROFILE_ROWS_PER_TABLE) continue;
    existing.push(payload);
    tables.set(tableName, existing);
  }

  const profileTables = [...tables.entries()].map(([table, rows]) => {
    const meta = tableMetadata(rows);
    return {
      table,
      recordCount: rows.length,
      columns: profileColumns(rows),
      ...(meta.schema ? { schema: meta.schema } : {}),
      ...(meta.tableRole ? { tableRole: meta.tableRole } : {}),
      ...(meta.primaryKey.length > 0 ? { primaryKey: meta.primaryKey } : {}),
      ...(meta.foreignKeys.length > 0 ? { foreignKeys: meta.foreignKeys } : {}),
    };
  });

  const document: SourceProfileDocument = {
    tables: profileTables,
    totalRecords: rawRows.length,
    profiledAt: new Date().toISOString(),
  };

  const [existingProfile] = await db
    .select()
    .from(sourceProfiles)
    .where(eq(sourceProfiles.sourceId, sourceId))
    .limit(1);

  if (existingProfile) {
    await db
      .update(sourceProfiles)
      .set({ document, profiledAt: new Date(), updatedAt: new Date() })
      .where(eq(sourceProfiles.id, existingProfile.id));
  } else {
    await db.insert(sourceProfiles).values({ sourceId, document });
  }

  await maybeTransitionSourceMaturity(db, sourceId, 'profiled', 'source_profiled', ['connected']);

  return document;
}

export async function getSourceProfile(
  db: Database,
  sourceId: string,
): Promise<SourceProfileDocument> {
  const [profile] = await db
    .select()
    .from(sourceProfiles)
    .where(eq(sourceProfiles.sourceId, sourceId))
    .limit(1);

  if (!profile) {
    throw GatewayError.notFound('Source profile not found');
  }

  return profile.document as SourceProfileDocument;
}

function profileColumns(rows: Record<string, unknown>[]): ProfileColumn[] {
  const columnNames = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key.startsWith('__')) continue;
      columnNames.add(key);
    }
  }

  return [...columnNames].map((name) => profileColumn(name, rows));
}

function profileColumn(name: string, rows: Record<string, unknown>[]): ProfileColumn {
  const values = rows.map((row) => row[name]);
  const nonNull = values.filter((value) => value !== null && value !== undefined);
  const nullCount = values.length - nonNull.length;
  const counts = new Map<string, number>();

  for (const value of nonNull) {
    const key = canonicalValue(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const suggestedValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SUGGESTED_VALUES)
    .map(([value, count]) => ({
      value: parseStoredValue(value),
      count,
    }));

  const inferredType = inferType(nonNull);
  const numericValues = nonNull
    .map((value) => Number(value))
    .filter((value) => !Number.isNaN(value));

  const topValues = inferredType === 'json' ? [] : suggestedValues.slice(0, 20);
  const column: ProfileColumn = {
    name,
    inferredType,
    cardinality: counts.size,
    nullCount,
    nullRate: rows.length === 0 ? 0 : nullCount / rows.length,
    topValues,
    suggestedValues,
    enumCandidate: inferredType !== 'json' && counts.size > 0 && counts.size <= MAX_SUGGESTED_VALUES,
  };

  if (inferredType === 'json') {
    const jsonShape = inferJsonShape(nonNull);
    if (Object.keys(jsonShape).length > 0) {
      column.jsonShape = jsonShape;
    }
  }

  if (inferredType === 'number' && numericValues.length > 0) {
    column.min = Math.min(...numericValues);
    column.max = Math.max(...numericValues);
  }

  if ((inferredType === 'date' || inferredType === 'datetime') && nonNull.length > 0) {
    const sorted = nonNull.map((value) => toScalarString(value)).sort();
    column.min = sorted[0];
    column.max = sorted[sorted.length - 1];
  }

  return column;
}

function inferType(values: unknown[]): ProfileColumn['inferredType'] {
  if (values.length === 0) return 'unknown';

  const types = new Set(
    values.map((value) => {
      if (typeof value === 'boolean') return 'boolean';
      if (typeof value === 'number') return 'number';
      if (value instanceof Date) return 'datetime';
      if (typeof value === 'object') return 'json';
      const text = toScalarString(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'date';
      if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return 'datetime';
      if (!Number.isNaN(Number(text)) && text.trim() !== '') return 'number';
      if (text === 'true' || text === 'false') return 'boolean';
      return 'string';
    }),
  );

  if (types.size === 1) {
    return [...types][0] ?? 'unknown';
  }
  if (types.has('string')) return 'string';
  return 'unknown';
}

function inferJsonShape(values: unknown[]): NonNullable<ProfileColumn['jsonShape']> {
  const byKey = new Map<string, unknown[]>();
  for (const value of values) {
    const parsed = parseJsonObject(value);
    if (!parsed) continue;
    for (const [key, nested] of Object.entries(parsed)) {
      const existing = byKey.get(key) ?? [];
      existing.push(nested);
      byKey.set(key, existing);
    }
  }

  const shape: NonNullable<ProfileColumn['jsonShape']> = {};
  for (const [key, nestedValues] of byKey.entries()) {
    const scalarValues = nestedValues.filter((value) => value !== null && value !== undefined);
    const counts = new Map<string, number>();
    for (const value of scalarValues) {
      if (typeof value === 'object') continue;
      const canonical = canonicalValue(value);
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
    const topValues = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([value, count]) => ({
        value: parseStoredValue(value),
        count,
      }));
    shape[key] = {
      inferredType: inferType(scalarValues),
      cardinality: counts.size,
      topValues,
    };
  }

  return shape;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function tableMetadata(rows: Record<string, unknown>[]): {
  schema?: string;
  tableRole?: 'entity' | 'lookup' | 'junction' | 'config';
  primaryKey: string[];
  foreignKeys: Array<{ column: string; referencedTable: string; referencedColumn: string }>;
} {
  const first = rows[0] ?? {};
  const foreignKeys = Array.isArray(first.__foreignKeys)
    ? first.__foreignKeys.filter(isForeignKey)
    : [];
  return {
    ...(typeof first.__schema === 'string' ? { schema: first.__schema } : {}),
    ...(isTableRole(first.__tableRole) ? { tableRole: first.__tableRole } : {}),
    primaryKey: Array.isArray(first.__primaryKey)
      ? first.__primaryKey.filter((value): value is string => typeof value === 'string')
      : [],
    foreignKeys,
  };
}

function isForeignKey(value: unknown): value is {
  column: string;
  referencedTable: string;
  referencedColumn: string;
} {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.column === 'string' &&
    typeof item.referencedTable === 'string' &&
    typeof item.referencedColumn === 'string'
  );
}

function isTableRole(value: unknown): value is 'entity' | 'lookup' | 'junction' | 'config' {
  return value === 'entity' || value === 'lookup' || value === 'junction' || value === 'config';
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return toScalarString(value);
}

function parseStoredValue(value: string): string | number | boolean | null {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== '') return asNumber;
  return value;
}

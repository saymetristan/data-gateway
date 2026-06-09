import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sourceProfiles, sourceRecordsRaw, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import { toScalarString } from '../utils/scalar.js';

export async function profileSource(db: Database, sourceId: string): Promise<SourceProfileDocument> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  const rawRows = await db
    .select()
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId));

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
    existing.push(payload);
    tables.set(tableName, existing);
  }

  const profileTables = [...tables.entries()].map(([table, rows]) => ({
    table,
    recordCount: rows.length,
    columns: profileColumns(rows),
  }));

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

  if (source.maturityStatus === 'connected') {
    await db
      .update(sources)
      .set({ maturityStatus: 'profiled', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
  }

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

  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([value, count]) => ({
      value: parseStoredValue(value),
      count,
    }));

  const inferredType = inferType(nonNull);
  const numericValues = nonNull
    .map((value) => Number(value))
    .filter((value) => !Number.isNaN(value));

  const column: ProfileColumn = {
    name,
    inferredType,
    cardinality: counts.size,
    nullCount,
    nullRate: rows.length === 0 ? 0 : nullCount / rows.length,
    topValues,
  };

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

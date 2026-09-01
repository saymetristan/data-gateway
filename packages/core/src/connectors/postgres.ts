import pg from 'pg';
import type {
  ConnectionValidation,
  DatabaseConnector,
  DatabaseRow,
  StreamRowsOptions,
  TableSchema,
} from './types.js';
import { detectCursorColumn, normalizeColumnType } from './normalize-type.js';
import { toScalarString } from '../utils/scalar.js';

const { Pool } = pg;

export class PostgresConnector implements DatabaseConnector {
  private pool: pg.Pool;

  constructor(connectionUrl: string) {
    this.pool = new Pool({ connectionString: connectionUrl });
  }

  async validateReadOnlyConnection(): Promise<ConnectionValidation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SELECT 1');
      await client.query('ROLLBACK');

      const roleCheck = await client.query<{ is_superuser: boolean }>(
        `SELECT rolsuper AS is_superuser FROM pg_roles WHERE rolname = current_user`,
      );
      if (roleCheck.rows[0]?.is_superuser) {
        return {
          ok: true,
          readOnly: false,
          dialect: 'postgres' as const,
          message: 'Connection user is superuser; use a SELECT-only role',
        };
      }

      const writeCheck = await client.query(`
        SELECT COUNT(*)::int AS write_privileges
        FROM information_schema.table_privileges
        WHERE grantee = current_user
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
      `);
      const row = writeCheck.rows[0] as { write_privileges: number };
      const readOnly = row.write_privileges === 0;

      return readOnly
        ? { ok: true, readOnly: true, dialect: 'postgres' as const }
        : {
            ok: true,
            readOnly: false,
            dialect: 'postgres' as const,
            message: 'Connection has write privileges',
          };
    } catch (error) {
      return {
        ok: false,
        readOnly: false,
        dialect: 'postgres',
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    } finally {
      client.release();
    }
  }

  async introspectSchema(): Promise<TableSchema[]> {
    const tablesResult = await this.pool.query<{
      table_schema: string;
      table_name: string;
    }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);

    const columnsResult = await this.pool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position
    `);

    const pkResult = await this.pool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(`
      SELECT
        n.nspname AS table_schema,
        c.relname AS table_name,
        a.attname AS column_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    const fkResult = await this.pool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
    }>(`
      SELECT
        source_namespace.nspname AS table_schema,
        source_table.relname AS table_name,
        source_column.attname AS column_name,
        target_table.relname AS foreign_table_name,
        target_column.attname AS foreign_column_name
      FROM pg_constraint constraint_def
      JOIN pg_class source_table ON source_table.oid = constraint_def.conrelid
      JOIN pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
      JOIN pg_class target_table ON target_table.oid = constraint_def.confrelid
      JOIN LATERAL generate_subscripts(constraint_def.conkey, 1) key_position(position)
        ON true
      JOIN pg_attribute source_column
        ON source_column.attrelid = constraint_def.conrelid
       AND source_column.attnum = constraint_def.conkey[key_position.position]
      JOIN pg_attribute target_column
        ON target_column.attrelid = constraint_def.confrelid
       AND target_column.attnum = constraint_def.confkey[key_position.position]
      WHERE constraint_def.contype = 'f'
        AND source_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY
        source_namespace.nspname,
        source_table.relname,
        constraint_def.conname,
        key_position.position
    `);

    const pkMap = new Map<string, string[]>();
    for (const row of pkResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const existing = pkMap.get(key) ?? [];
      existing.push(row.column_name);
      pkMap.set(key, existing);
    }

    const fkMap = new Map<string, TableSchema['foreignKeys']>();
    for (const row of fkResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const existing = fkMap.get(key) ?? [];
      existing.push({
        column: row.column_name,
        referencedTable: row.foreign_table_name,
        referencedColumn: row.foreign_column_name,
      });
      fkMap.set(key, existing);
    }

    const columnsByTable = new Map<string, TableSchema['columns']>();
    for (const row of columnsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const existing = columnsByTable.get(key) ?? [];
      const pk = pkMap.get(key) ?? [];
      existing.push({
        name: row.column_name,
        dataType: row.data_type,
        normalizedType: normalizeColumnType(row.data_type, 'postgres'),
        nullable: row.is_nullable === 'YES',
        isPrimaryKey: pk.includes(row.column_name),
      });
      columnsByTable.set(key, existing);
    }

    return tablesResult.rows.map((row) => {
      const key = `${row.table_schema}.${row.table_name}`;
      const columns = columnsByTable.get(key) ?? [];
      const primaryKey = pkMap.get(key) ?? [];
      const cursorColumn = detectCursorColumn(columns.map((c) => c.name));
      return {
        name: row.table_name,
        schema: row.table_schema,
        columns,
        primaryKey,
        foreignKeys: fkMap.get(key) ?? [],
        ...(cursorColumn ? { cursorColumn } : {}),
      };
    });
  }

  async *streamRows(table: string, opts: StreamRowsOptions): AsyncIterable<DatabaseRow[]> {
    const qualified = table.includes('.') ? table.split('.') : ['public', table];
    const schema = qualified[0] ?? 'public';
    const tableName = qualified[1] ?? table;
    const quoted = `"${schema.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}"`;

    let lastCursor: string | undefined = opts.cursorValue;
    let lastTieBreaker: string | undefined = opts.cursorTieBreakerValue;
    const batchSize = opts.batchSize;
    let offset = 0;

    for (;;) {
      let query = `SELECT * FROM ${quoted}`;
      const params: unknown[] = [];

      if (opts.cursorColumn && lastCursor !== undefined) {
        params.push(lastCursor);
        const cursorIdentifier = quoteIdentifier(opts.cursorColumn);

        if (opts.cursorTieBreakerColumn && lastTieBreaker !== undefined) {
          params.push(lastTieBreaker);
          const tieBreakerIdentifier = quoteIdentifier(opts.cursorTieBreakerColumn);
          query += ` WHERE (${cursorIdentifier}, ${tieBreakerIdentifier}) > ($1, $2)`;
        } else {
          query += ` WHERE ${cursorIdentifier} > $${String(params.length)}`;
        }
      }

      const orderBy = opts.cursorColumn
        ? [opts.cursorColumn, ...(opts.cursorTieBreakerColumn ? [opts.cursorTieBreakerColumn] : [])]
        : (opts.orderBy ?? []);

      if (orderBy.length > 0) {
        query += ` ORDER BY ${orderBy.map(quoteIdentifier).join(', ')}`;
      }

      params.push(batchSize);
      query += ` LIMIT $${String(params.length)}`;

      if (!opts.cursorColumn) {
        params.push(offset);
        query += ` OFFSET $${String(params.length)}`;
      }

      const result = await this.pool.query(query, params);
      if (result.rows.length === 0) break;

      const rows = result.rows as DatabaseRow[];
      yield rows;

      if (rows.length < batchSize) break;

      if (opts.cursorColumn) {
        const lastRow = rows[rows.length - 1];
        const cursorValue = lastRow?.[opts.cursorColumn];
        if (cursorValue === undefined || cursorValue === null) break;
        lastCursor = toScalarString(cursorValue);
        if (opts.cursorTieBreakerColumn) {
          const tieBreakerValue = lastRow?.[opts.cursorTieBreakerColumn];
          if (tieBreakerValue === undefined || tieBreakerValue === null) break;
          lastTieBreaker = toScalarString(tieBreakerValue);
        }
      } else {
        offset += rows.length;
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

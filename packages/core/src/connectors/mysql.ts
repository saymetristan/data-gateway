import mysql from 'mysql2/promise';
import type {
  ConnectionValidation,
  DatabaseConnector,
  DatabaseRow,
  StreamRowsOptions,
  TableSchema,
} from './types.js';
import { detectCursorColumn, normalizeColumnType } from './normalize-type.js';
import { toScalarString } from '../utils/scalar.js';

export class MysqlConnector implements DatabaseConnector {
  private pool: mysql.Pool;
  private database: string;

  constructor(connectionUrl: string) {
    const url = new URL(connectionUrl);
    this.database = url.pathname.replace(/^\//, '');
    this.pool = mysql.createPool(connectionUrl);
  }

  async validateReadOnlyConnection(): Promise<ConnectionValidation> {
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW GRANTS FOR CURRENT_USER()`,
      );
      const grants = rows.map((row) => Object.values(row).join(' ')).join('\n').toUpperCase();
      const hasWrite =
        grants.includes('ALL PRIVILEGES') ||
        grants.includes('GRANT OPTION') ||
        grants.includes('INSERT') ||
        grants.includes('UPDATE') ||
        grants.includes('DELETE') ||
        grants.includes('CREATE') ||
        grants.includes('DROP') ||
        grants.includes('ALTER') ||
        grants.includes('INDEX') ||
        grants.includes('TRIGGER') ||
        grants.includes('REFERENCES');
      const readOnly = grants.includes('SELECT') && !hasWrite;

      return readOnly
        ? { ok: true, readOnly: true, dialect: 'mysql' as const }
        : {
            ok: true,
            readOnly: false,
            dialect: 'mysql' as const,
            message: 'Connection has write privileges',
          };
    } catch (error) {
      return {
        ok: false,
        readOnly: false,
        dialect: 'mysql',
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  async introspectSchema(): Promise<TableSchema[]> {
    const [tables] = await this.pool.query<mysql.RowDataPacket[]>(
      `
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `,
      [this.database],
    );

    const [columns] = await this.pool.query<mysql.RowDataPacket[]>(
      `
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_key
        FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY table_name, ordinal_position
      `,
      [this.database],
    );

    const [foreignKeys] = await this.pool.query<mysql.RowDataPacket[]>(
      `
        SELECT
          table_name,
          column_name,
          referenced_table_name,
          referenced_column_name
        FROM information_schema.key_column_usage
        WHERE table_schema = ?
          AND referenced_table_name IS NOT NULL
      `,
      [this.database],
    );

    const columnsByTable = new Map<string, TableSchema['columns']>();
    for (const row of columns) {
      const key = String(row.table_name);
      const existing = columnsByTable.get(key) ?? [];
      existing.push({
        name: String(row.column_name),
        dataType: String(row.data_type),
        normalizedType: normalizeColumnType(String(row.data_type), 'mysql'),
        nullable: String(row.is_nullable) === 'YES',
        isPrimaryKey: String(row.column_key) === 'PRI',
      });
      columnsByTable.set(key, existing);
    }

    const fkMap = new Map<string, TableSchema['foreignKeys']>();
    for (const row of foreignKeys) {
      const key = String(row.table_name);
      const existing = fkMap.get(key) ?? [];
      existing.push({
        column: String(row.column_name),
        referencedTable: String(row.referenced_table_name),
        referencedColumn: String(row.referenced_column_name),
      });
      fkMap.set(key, existing);
    }

    return tables.map((row) => {
      const tableName = String(row.table_name);
      const tableColumns = columnsByTable.get(tableName) ?? [];
      const primaryKey = tableColumns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      const cursorColumn = detectCursorColumn(tableColumns.map((c) => c.name));
      return {
        name: tableName,
        schema: String(row.table_schema),
        columns: tableColumns,
        primaryKey,
        foreignKeys: fkMap.get(tableName) ?? [],
        ...(cursorColumn ? { cursorColumn } : {}),
      };
    });
  }

  async *streamRows(table: string, opts: StreamRowsOptions): AsyncIterable<DatabaseRow[]> {
    const tableName = table.includes('.') ? (table.split('.')[1] ?? table) : table;
    const quoted = `\`${tableName.replace(/`/g, '``')}\``;
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
          query += ` WHERE (${cursorIdentifier}, ${tieBreakerIdentifier}) > (?, ?)`;
        } else {
          query += ` WHERE ${cursorIdentifier} > ?`;
        }
      }

      const orderBy = opts.cursorColumn
        ? [opts.cursorColumn, ...(opts.cursorTieBreakerColumn ? [opts.cursorTieBreakerColumn] : [])]
        : (opts.orderBy ?? []);

      if (orderBy.length > 0) {
        query += ` ORDER BY ${orderBy.map(quoteIdentifier).join(', ')}`;
      }

      params.push(batchSize);
      query += ' LIMIT ?';

      if (!opts.cursorColumn) {
        params.push(offset);
        query += ' OFFSET ?';
      }

      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(query, params);
      if (rows.length === 0) break;

      const batch = rows as DatabaseRow[];
      yield batch;

      if (batch.length < batchSize) break;

      if (opts.cursorColumn) {
        const lastRow = batch[batch.length - 1];
        const cursorValue = lastRow?.[opts.cursorColumn];
        if (cursorValue === undefined || cursorValue === null) break;
        lastCursor = toScalarString(cursorValue);
        if (opts.cursorTieBreakerColumn) {
          const tieBreakerValue = lastRow?.[opts.cursorTieBreakerColumn];
          if (tieBreakerValue === undefined || tieBreakerValue === null) break;
          lastTieBreaker = toScalarString(tieBreakerValue);
        }
      } else {
        offset += batch.length;
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

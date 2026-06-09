export type ColumnType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
  | 'unknown';

export type ColumnSchema = {
  name: string;
  dataType: string;
  normalizedType: ColumnType;
  nullable: boolean;
  isPrimaryKey: boolean;
};

export type ForeignKeySchema = {
  column: string;
  referencedTable: string;
  referencedColumn: string;
};

export type TableSchema = {
  name: string;
  schema: string;
  columns: ColumnSchema[];
  primaryKey: string[];
  foreignKeys: ForeignKeySchema[];
  cursorColumn?: string;
};

export type ConnectionValidation = {
  ok: boolean;
  readOnly: boolean;
  dialect: 'postgres' | 'mysql';
  message?: string;
};

export type StreamRowsOptions = {
  cursorColumn?: string;
  cursorValue?: string;
  batchSize: number;
};

export type DatabaseRow = Record<string, unknown>;

export interface DatabaseConnector {
  validateReadOnlyConnection(): Promise<ConnectionValidation>;
  introspectSchema(): Promise<TableSchema[]>;
  streamRows(table: string, opts: StreamRowsOptions): AsyncIterable<DatabaseRow[]>;
  close(): Promise<void>;
}

import { detectDialect } from './dialect.js';
import { MysqlConnector } from './mysql.js';
import { PostgresConnector } from './postgres.js';
import type { DatabaseConnector } from './types.js';

export function createDatabaseConnector(connectionUrl: string): DatabaseConnector {
  const dialect = detectDialect(connectionUrl);
  if (dialect === 'postgres') {
    return new PostgresConnector(connectionUrl);
  }
  return new MysqlConnector(connectionUrl);
}

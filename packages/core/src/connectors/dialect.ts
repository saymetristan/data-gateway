export type DatabaseDialect = 'postgres' | 'mysql';

export function detectDialect(connectionUrl: string): DatabaseDialect {
  const url = new URL(connectionUrl);
  const protocol = url.protocol.replace(':', '');

  if (protocol === 'postgres' || protocol === 'postgresql') {
    return 'postgres';
  }
  if (protocol === 'mysql' || protocol === 'mysql2') {
    return 'mysql';
  }

  throw new Error(`Unsupported database URL scheme: ${protocol}`);
}

import { sql, type SQL } from 'drizzle-orm';

/**
 * Build weighted tsvector SQL from A/B/C/D text buckets.
 * Empty buckets are omitted.
 */
export function buildWeightedTsvectorSql(parts: {
  A: string;
  B: string;
  C: string;
  D: string;
}): SQL {
  const fragments: SQL[] = [];
  for (const weight of ['A', 'B', 'C', 'D'] as const) {
    const text = parts[weight].trim();
    if (!text) continue;
    fragments.push(
      sql`setweight(to_tsvector('es_unaccent', public.f_unaccent(${text})), ${weight})`,
    );
  }
  if (fragments.length === 0) {
    return sql`to_tsvector('es_unaccent', '')`;
  }
  return sql.join(fragments, sql` || `);
}

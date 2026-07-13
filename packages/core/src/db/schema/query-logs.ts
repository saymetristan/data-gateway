import { pgTable, uuid, text, jsonb, integer, doublePrecision, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

export const queryLogs = pgTable(
  'query_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id'),
    sourceId: uuid('source_id'),
    rawQuery: text('raw_query'),
    structuredQuery: jsonb('structured_query'),
    queryType: text('query_type'),
    appliedFilters: jsonb('applied_filters'),
    resultsCount: integer('results_count'),
    confidence: doublePrecision('confidence'),
    latencyMs: integer('latency_ms'),
    warnings: jsonb('warnings').default([]),
    error: text('error'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('query_logs_workspace_id_idx').on(table.workspaceId),
    index('query_logs_created_at_idx').on(table.createdAt),
  ],
);

export type QueryLog = typeof queryLogs.$inferSelect;
export type NewQueryLog = typeof queryLogs.$inferInsert;

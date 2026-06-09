import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

export const recordEnrichments = pgTable(
  'record_enrichments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceRecordId: text('source_record_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    promptHash: text('prompt_hash').notNull(),
    output: jsonb('output').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('record_enrichments_cache_unique').on(
      table.sourceId,
      table.sourceRecordId,
      table.payloadHash,
      table.promptHash,
    ),
  ],
);

export type RecordEnrichment = typeof recordEnrichments.$inferSelect;
export type NewRecordEnrichment = typeof recordEnrichments.$inferInsert;

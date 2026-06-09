import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

export const sourceRecordsRaw = pgTable(
  'source_records_raw',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sourceRecordId: text('source_record_id').notNull(),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('source_records_raw_source_record_unique').on(
      table.sourceId,
      table.sourceRecordId,
    ),
    index('source_records_raw_source_id_idx').on(table.sourceId),
  ],
);

export type SourceRecordRaw = typeof sourceRecordsRaw.$inferSelect;
export type NewSourceRecordRaw = typeof sourceRecordsRaw.$inferInsert;

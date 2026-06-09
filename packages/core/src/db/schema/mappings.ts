import { pgEnum, pgTable, uuid, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

export const mappingStatusEnum = pgEnum('mapping_status', ['draft', 'active']);

export const mappings = pgTable(
  'mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    document: jsonb('document').notNull(),
    status: mappingStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mappings_source_version_unique').on(table.sourceId, table.version),
    index('mappings_source_id_idx').on(table.sourceId),
  ],
);

export type Mapping = typeof mappings.$inferSelect;
export type NewMapping = typeof mappings.$inferInsert;

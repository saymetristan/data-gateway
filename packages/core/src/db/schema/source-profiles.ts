import { pgTable, uuid, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

export const sourceProfiles = pgTable(
  'source_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    document: jsonb('document').notNull(),
    profiledAt: timestamp('profiled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('source_profiles_source_id_unique').on(table.sourceId)],
);

export type SourceProfile = typeof sourceProfiles.$inferSelect;
export type NewSourceProfile = typeof sourceProfiles.$inferInsert;

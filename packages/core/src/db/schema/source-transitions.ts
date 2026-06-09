import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { maturityStatusEnum, sources } from './sources.js';

export const sourceTransitions = pgTable(
  'source_transitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    fromStatus: maturityStatusEnum('from_status').notNull(),
    toStatus: maturityStatusEnum('to_status').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('source_transitions_source_id_idx').on(table.sourceId)],
);

export type SourceTransition = typeof sourceTransitions.$inferSelect;
export type NewSourceTransition = typeof sourceTransitions.$inferInsert;

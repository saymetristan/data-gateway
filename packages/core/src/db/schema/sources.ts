import { pgEnum, pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

export const sourceTypeEnum = pgEnum('source_type', ['database_url', 'csv', 'shopify']);

export const maturityStatusEnum = pgEnum('maturity_status', [
  'connected',
  'profiled',
  'indexed',
  'mapped',
  'validated',
  'agent_ready',
]);

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: sourceTypeEnum('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull().default({}),
    maturityStatus: maturityStatusEnum('maturity_status').notNull().default('connected'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sources_workspace_id_idx').on(table.workspaceId),
    index('sources_workspace_maturity_idx').on(table.workspaceId, table.maturityStatus),
  ],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;

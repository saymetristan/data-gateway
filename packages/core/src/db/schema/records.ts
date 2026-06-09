import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tsvector } from '../custom-types.js';
import { workspaces } from './workspaces.js';
import { sources } from './sources.js';

export const records = pgTable(
  'records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    externalId: text('external_id').notNull(),
    data: jsonb('data').notNull().default({}),
    mappingVersion: integer('mapping_version').notNull().default(0),
    searchText: tsvector('search_text').generatedAlwaysAs(
      sql`to_tsvector('es_unaccent', public.f_unaccent(
        coalesce(data->>'name', '') || ' ' ||
        coalesce(data->>'description', '') || ' ' ||
        coalesce(data->>'title', '') || ' ' ||
        coalesce(data->>'sku', '')
      ))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('records_source_entity_external_unique').on(
      table.sourceId,
      table.entity,
      table.externalId,
    ),
    index('records_workspace_id_idx').on(table.workspaceId),
    index('records_workspace_entity_idx').on(table.workspaceId, table.entity),
    index('records_search_text_idx').using('gin', table.searchText),
    index('records_data_idx').using('gin', table.data),
  ],
);

export type RecordRow = typeof records.$inferSelect;
export type NewRecordRow = typeof records.$inferInsert;

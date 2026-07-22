import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { apiKeys } from './api-keys.js';
import { sources } from './sources.js';
import { workspaces } from './workspaces.js';

export const retrievalPolicyStatusEnum = pgEnum('retrieval_policy_status', [
  'draft',
  'active',
  'archived',
]);

export const sourceRetrievalPolicies = pgTable(
  'source_retrieval_policies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: retrievalPolicyStatusEnum('status').notNull().default('draft'),
    document: jsonb('document').notNull(),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('source_retrieval_policies_source_version_unique').on(
      table.sourceId,
      table.version,
    ),
    uniqueIndex('source_retrieval_policies_one_active_unique')
      .on(table.sourceId)
      .where(sql`${table.status} = 'active'`),
    index('source_retrieval_policies_workspace_idx').on(table.workspaceId),
    index('source_retrieval_policies_source_status_idx').on(
      table.sourceId,
      table.status,
    ),
  ],
);

export type SourceRetrievalPolicy = typeof sourceRetrievalPolicies.$inferSelect;
export type NewSourceRetrievalPolicy = typeof sourceRetrievalPolicies.$inferInsert;

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { vector1024 } from '../custom-types.js';
import { workspaces } from './workspaces.js';

export const queryEmbeddingCache = pgTable(
  'query_embedding_cache',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    queryHash: text('query_hash').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embeddingDims: integer('embedding_dims').notNull(),
    embedding: vector1024('embedding').notNull(),
    hitCount: integer('hit_count').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('query_embedding_cache_ws_hash_model_dims_unique').on(
      table.workspaceId,
      table.queryHash,
      table.embeddingModel,
      table.embeddingDims,
    ),
    index('query_embedding_cache_expires_at_idx').on(table.expiresAt),
    index('query_embedding_cache_workspace_id_idx').on(table.workspaceId),
  ],
);

export type QueryEmbeddingCacheRow = typeof queryEmbeddingCache.$inferSelect;
export type NewQueryEmbeddingCacheRow = typeof queryEmbeddingCache.$inferInsert;

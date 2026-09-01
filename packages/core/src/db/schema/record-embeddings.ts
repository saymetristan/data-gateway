import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { vector1024 } from '../custom-types.js';
import { records } from './records.js';

export const recordEmbeddings = pgTable(
  'record_embeddings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    embedding: vector1024('embedding').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embeddingDims: integer('embedding_dims').notNull().default(1024),
    mappingVersion: integer('mapping_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('record_embeddings_record_id_idx').on(table.recordId),
    uniqueIndex('record_embeddings_record_model_version_unique').on(
      table.recordId,
      table.embeddingModel,
      table.mappingVersion,
    ),
    index('record_embeddings_model_version_idx').on(
      table.embeddingModel,
      table.mappingVersion,
    ),
    index('record_embeddings_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
);

export type RecordEmbedding = typeof recordEmbeddings.$inferSelect;
export type NewRecordEmbedding = typeof recordEmbeddings.$inferInsert;

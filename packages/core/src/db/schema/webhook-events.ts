import { pgEnum, pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

export const webhookEventStatusEnum = pgEnum('webhook_event_status', [
  'processing',
  'completed',
  'failed',
]);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    webhookId: text('webhook_id').notNull(),
    status: webhookEventStatusEnum('status').notNull().default('processing'),
    topic: text('topic').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_webhook_unique').on(table.provider, table.webhookId),
    index('webhook_events_source_id_idx').on(table.sourceId),
  ],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;

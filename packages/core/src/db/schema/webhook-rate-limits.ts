import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const webhookRateLimits = pgTable('webhook_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WebhookRateLimit = typeof webhookRateLimits.$inferSelect;

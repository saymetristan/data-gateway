import { and, eq, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { webhookEvents } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';

const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const WEBHOOK_RATE_LIMIT_MAX = 300;
const WEBHOOK_PROCESSING_STALE_MS = 15 * 60_000;

export async function enforceDistributedWebhookRateLimit(
  db: Database,
  key: string,
): Promise<void> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + WEBHOOK_RATE_LIMIT_WINDOW_MS);
  const normalizedKey = key.toLowerCase();

  const rows = await db.execute<{ count: number }>(sql`
    INSERT INTO webhook_rate_limits ("key", "count", "reset_at", "updated_at")
    VALUES (${normalizedKey}, 1, ${resetAt}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN webhook_rate_limits."reset_at" <= ${now} THEN 1
        ELSE webhook_rate_limits."count" + 1
      END,
      "reset_at" = CASE
        WHEN webhook_rate_limits."reset_at" <= ${now} THEN ${resetAt}
        ELSE webhook_rate_limits."reset_at"
      END,
      "updated_at" = ${now}
    RETURNING "count"
  `);
  const row = rows.rows[0];
  if (row && row.count > WEBHOOK_RATE_LIMIT_MAX) {
    throw GatewayError.rateLimited('Shopify webhook rate limit exceeded');
  }
}

export async function startWebhookEventProcessing(
  db: Database,
  input: { sourceId: string; provider: string; webhookId?: string | null; topic: string },
): Promise<boolean> {
  if (!input.webhookId) return true;

  const now = new Date();
  const staleBefore = new Date(now.getTime() - WEBHOOK_PROCESSING_STALE_MS);
  const [event] = await db
    .insert(webhookEvents)
    .values({
      sourceId: input.sourceId,
      provider: input.provider,
      webhookId: input.webhookId,
      topic: input.topic,
      status: 'processing',
    })
    .onConflictDoUpdate({
      target: [webhookEvents.provider, webhookEvents.webhookId],
      set: {
        status: 'processing',
        topic: input.topic,
        updatedAt: now,
        failedAt: null,
      },
      where: sql`${or(
        eq(webhookEvents.status, 'failed'),
        and(
          eq(webhookEvents.status, 'processing'),
          sql`${webhookEvents.updatedAt} < ${staleBefore}`,
        ),
      )}`,
    })
    .returning({ status: webhookEvents.status });

  return event?.status === 'processing';
}

export async function completeWebhookEvent(
  db: Database,
  provider: string,
  webhookId?: string | null,
): Promise<void> {
  if (!webhookId) return;
  const now = new Date();
  await db
    .update(webhookEvents)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.webhookId, webhookId)));
}

export async function failWebhookEvent(
  db: Database,
  provider: string,
  webhookId?: string | null,
): Promise<void> {
  if (!webhookId) return;
  const now = new Date();
  await db
    .update(webhookEvents)
    .set({ status: 'failed', failedAt: now, updatedAt: now })
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.webhookId, webhookId)));
}

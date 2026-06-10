const MAX_ENTRIES = 10_000;
const seenWebhookIds = new Map<string, number>();

export function isDuplicateWebhook(webhookId: string, ttlMs = 24 * 60 * 60 * 1000): boolean {
  const now = Date.now();
  pruneExpired(now, ttlMs);

  const seenAt = seenWebhookIds.get(webhookId);
  if (seenAt !== undefined && now - seenAt < ttlMs) {
    return true;
  }

  seenWebhookIds.set(webhookId, now);
  if (seenWebhookIds.size > MAX_ENTRIES) {
    const oldest = seenWebhookIds.keys().next().value;
    if (oldest) seenWebhookIds.delete(oldest);
  }

  return false;
}

function pruneExpired(now: number, ttlMs: number): void {
  for (const [id, seenAt] of seenWebhookIds) {
    if (now - seenAt >= ttlMs) {
      seenWebhookIds.delete(id);
    }
  }
}

export function resetWebhookDedupeForTests(): void {
  seenWebhookIds.clear();
}

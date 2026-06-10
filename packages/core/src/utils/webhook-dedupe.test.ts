import { describe, it, expect, beforeEach } from 'vitest';
import { isDuplicateWebhook, resetWebhookDedupeForTests } from './webhook-dedupe.js';

describe('webhook dedupe', () => {
  beforeEach(() => {
    resetWebhookDedupeForTests();
  });

  it('detecta webhooks duplicados por id', () => {
    expect(isDuplicateWebhook('wh_1')).toBe(false);
    expect(isDuplicateWebhook('wh_1')).toBe(true);
    expect(isDuplicateWebhook('wh_2')).toBe(false);
  });
});

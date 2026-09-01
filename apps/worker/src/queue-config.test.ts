import { describe, expect, it } from 'vitest';
import {
  EMBEDDINGS_GENERATE_JOB,
  EMBEDDINGS_PURGE_STALE_JOB,
  SOURCE_INDEX_JOB,
} from '@data-gateway/core';
import { queueOptions } from './queue-config.js';

describe('worker queue configuration', () => {
  it('allows embedding jobs to run beyond the pg-boss 15 minute default', () => {
    expect(queueOptions(EMBEDDINGS_GENERATE_JOB)).toMatchObject({
      expireInSeconds: 2 * 60 * 60,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    });
    expect(queueOptions(SOURCE_INDEX_JOB)).toMatchObject({
      expireInSeconds: 4 * 60 * 60,
    });
  });

  it('retries deferred stale purges while a backfill is active', () => {
    expect(queueOptions(EMBEDDINGS_PURGE_STALE_JOB)).toMatchObject({
      expireInSeconds: 10 * 60,
      retryLimit: 720,
      retryDelay: 60,
      retryBackoff: false,
    });
  });
});

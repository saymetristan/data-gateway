import type PgBoss from 'pg-boss';
import {
  EMBEDDINGS_GENERATE_JOB,
  EMBEDDINGS_PURGE_STALE_JOB,
  EMBEDDING_JOB_EXPIRE_HOURS,
  SOURCE_INDEX_JOB,
  SOURCE_INDEX_JOB_EXPIRE_HOURS,
} from '@data-gateway/core';

export function queueOptions(queue: string): PgBoss.Queue | undefined {
  if (queue === EMBEDDINGS_GENERATE_JOB) {
    return {
      name: queue,
      expireInSeconds: EMBEDDING_JOB_EXPIRE_HOURS * 60 * 60,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    };
  }
  if (queue === SOURCE_INDEX_JOB) {
    return {
      name: queue,
      expireInSeconds: SOURCE_INDEX_JOB_EXPIRE_HOURS * 60 * 60,
    };
  }
  if (queue === EMBEDDINGS_PURGE_STALE_JOB) {
    return {
      name: queue,
      expireInSeconds: 10 * 60,
      retryLimit: 720,
      retryDelay: 60,
      retryBackoff: false,
    };
  }
  return undefined;
}

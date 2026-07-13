export const SOURCE_SYNC_JOB = 'source.sync';
export const SOURCE_PROFILE_JOB = 'source.profile';
export const SOURCE_INDEX_JOB = 'source.index';
export const EMBEDDINGS_GENERATE_JOB = 'embeddings.generate';
export const EVALS_RUN_JOB = 'evals.run';
export const SHOPIFY_WEBHOOK_JOB = 'shopify.webhook';
export const SHOPIFY_SYNC_SCHEDULED_JOB = 'shopify.sync.scheduled';
export const HEALTH_HEARTBEAT_JOB = 'health.heartbeat';
export const QUERY_EMBEDDING_CACHE_PURGE_JOB = 'query.embedding_cache.purge';

export const SOURCE_SYNC_EXPIRE_IN_HOURS = 2;
export const SOURCE_SYNC_SINGLETON_MINUTES = 10;

/** Colas que deben existir antes de work/schedule/send (pg-boss v10). */
export const ALL_JOB_QUEUES = [
  SOURCE_SYNC_JOB,
  SOURCE_PROFILE_JOB,
  SOURCE_INDEX_JOB,
  EMBEDDINGS_GENERATE_JOB,
  EVALS_RUN_JOB,
  SHOPIFY_WEBHOOK_JOB,
  SHOPIFY_SYNC_SCHEDULED_JOB,
  HEALTH_HEARTBEAT_JOB,
  QUERY_EMBEDDING_CACHE_PURGE_JOB,
] as const;

export type SourceSyncJobData = {
  sourceId: string;
  workspaceId: string;
  fullSync?: boolean;
};

export type SourceProfileJobData = {
  sourceId: string;
  workspaceId: string;
};

export type SourceIndexJobData = {
  sourceId: string;
  workspaceId: string;
  invalidateMaturity?: boolean;
};

export type ShopifyWebhookJobData = {
  sourceId: string;
  workspaceId: string;
  topic: string;
  payload: Record<string, unknown>;
  webhookId?: string;
};

export type EmbeddingsGenerateJobData = {
  sourceId: string;
  workspaceId: string;
  recordIds: string[];
  mappingVersion: number;
};

export type EvalsRunJobData = {
  evalRunId: string;
  workspaceId: string;
};

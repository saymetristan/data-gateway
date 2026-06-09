export const SOURCE_SYNC_JOB = 'source.sync';
export const SOURCE_PROFILE_JOB = 'source.profile';
export const SOURCE_INDEX_JOB = 'source.index';
export const EMBEDDINGS_GENERATE_JOB = 'embeddings.generate';
export const EVALS_RUN_JOB = 'evals.run';

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

import { serve } from '@hono/node-server';
import { createDb } from '@data-gateway/core';
import { createApp } from './app.js';
import { loadApiEnv } from './env.js';
import { createEmbeddingProvider, createLlmProvider, createWorkspaceEmbeddingProviderSelector } from './providers.js';

const env = loadApiEnv();
const db = createDb(env.DATABASE_URL);
const embeddingProvider = createEmbeddingProvider(env);
const app = createApp({
  env,
  db,
  embeddingProvider,
  embeddingProviderForWorkspace: createWorkspaceEmbeddingProviderSelector(env, embeddingProvider),
  llmProvider: createLlmProvider(env),
});

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`API listening on http://localhost:${String(info.port)}`);
  },
);

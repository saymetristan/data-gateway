import { serve } from '@hono/node-server';
import { createDb } from '@data-gateway/core';
import { createApp } from './app.js';
import { loadApiEnv } from './env.js';
import { createEmbeddingProvider, createLlmProvider } from './providers.js';

const env = loadApiEnv();
const db = createDb(env.DATABASE_URL);
const app = createApp({
  env,
  db,
  embeddingProvider: createEmbeddingProvider(env),
  llmProvider: createLlmProvider(env),
});

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`API listening on http://localhost:${String(info.port)}`);
  },
);

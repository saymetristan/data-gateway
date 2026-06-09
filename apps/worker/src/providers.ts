import {
  MockEmbeddingProvider,
  MockLlmProvider,
  OpenRouterEmbeddingProvider,
  OpenRouterLlmProvider,
  type EmbeddingProvider,
  type LlmProvider,
} from '@data-gateway/core';
import type { WorkerEnv } from './env.js';

export function createEmbeddingProvider(env: WorkerEnv): EmbeddingProvider {
  if (env.USE_MOCK_PROVIDERS || env.NODE_ENV === 'test' || !env.OPENROUTER_API_KEY) {
    return new MockEmbeddingProvider(env.EMBEDDING_DIMENSIONS);
  }

  return new OpenRouterEmbeddingProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
  });
}

export function createLlmProvider(env: WorkerEnv): LlmProvider {
  if (env.USE_MOCK_PROVIDERS || env.NODE_ENV === 'test' || !env.OPENROUTER_API_KEY) {
    return new MockLlmProvider();
  }

  return new OpenRouterLlmProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.LLM_MODEL,
  });
}

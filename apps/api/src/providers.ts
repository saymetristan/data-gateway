import {
  MockEmbeddingProvider,
  MockLlmProvider,
  OpenRouterEmbeddingProvider,
  OpenRouterLlmProvider,
  type EmbeddingProvider,
  type LlmProvider,
} from '@data-gateway/core';
import type { ApiEnv } from './env.js';

export function createEmbeddingProvider(env: ApiEnv): EmbeddingProvider {
  if (env.USE_MOCK_PROVIDERS || env.NODE_ENV === 'test' || !env.OPENROUTER_API_KEY) {
    return new MockEmbeddingProvider(env.EMBEDDING_DIMENSIONS);
  }

  return new OpenRouterEmbeddingProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    softDeadlineMs: env.EMBEDDING_SOFT_DEADLINE_MS,
    hardTimeoutMs: env.EMBEDDING_HARD_TIMEOUT_MS,
    circuitFailureThreshold: env.EMBEDDING_CIRCUIT_FAILURE_THRESHOLD,
    circuitRecoveryMs: env.EMBEDDING_CIRCUIT_RECOVERY_MS,
  });
}

export function createLlmProvider(env: ApiEnv): LlmProvider {
  if (env.USE_MOCK_PROVIDERS || env.NODE_ENV === 'test' || !env.OPENROUTER_API_KEY) {
    return new MockLlmProvider();
  }

  return new OpenRouterLlmProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.LLM_MODEL,
  });
}

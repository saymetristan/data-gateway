import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEnvSchema } from './env.js';
import { createEmbeddingProvider, createWorkspaceEmbeddingProviderSelector } from './providers.js';

const workspace = '8d6db7db-dabe-4bea-ad09-46fd604b97cd';
const config = {
  DATABASE_URL: 'postgresql://localhost/unused',
  ADMIN_API_KEY: 'unit-test-admin-key',
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  NODE_ENV: 'production',
  OPENROUTER_API_KEY: 'unit-test-key',
  EMBEDDING_DIMENSIONS: 2,
};

afterEach(() => vi.unstubAllGlobals());

describe('workspace embedding routing', () => {
  it('keeps default routing unless the authenticated workspace is configured', async () => {
    const env = apiEnvSchema.parse({
      ...config,
      EMBEDDING_PROVIDER_ORDER_BY_WORKSPACE: JSON.stringify({ [workspace]: ['deepinfra', 'nebius'] }),
    });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2] }], provider: 'DeepInfra', id: 'gen-emb-test',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const defaultProvider = createEmbeddingProvider(env);
    const select = createWorkspaceEmbeddingProviderSelector(env, defaultProvider);
    expect(select('another-workspace')).toBe(defaultProvider);
    expect(select(workspace)).toBe(select(workspace));
    expect(select(workspace).model).toBe(defaultProvider.model);
    expect(select(workspace).dimensions).toBe(defaultProvider.dimensions);
    await select(workspace).embed(['apple']);
    await select('another-workspace').embed(['apple']);
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as { provider: unknown });
    expect(payloads[0]?.provider).toEqual({ order: ['deepinfra', 'nebius'], allow_fallbacks: true });
    expect(payloads[1]?.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
  });

  it('uses the default instance when routing is absent', () => {
    const env = apiEnvSchema.parse(config);
    const provider = createEmbeddingProvider(env);
    expect(createWorkspaceEmbeddingProviderSelector(env, provider)(workspace)).toBe(provider);
  });

  it.each(['', '   '])('accepts an empty routing variable as disabled', (value) => {
    expect(apiEnvSchema.parse({ ...config, EMBEDDING_PROVIDER_ORDER_BY_WORKSPACE: value }).EMBEDDING_PROVIDER_ORDER_BY_WORKSPACE).toBeUndefined();
  });

  it.each(['invalid', '[]', '{"bad-id":["deepinfra"]}', JSON.stringify({ [workspace]: [] }), JSON.stringify({ [workspace]: ['bad provider'] })])(
    'rejects malformed routing at startup: %s', (value) => {
      expect(apiEnvSchema.safeParse({ ...config, EMBEDDING_PROVIDER_ORDER_BY_WORKSPACE: value }).success).toBe(false);
    },
  );
});

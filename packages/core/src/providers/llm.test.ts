import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterLlmProvider } from './llm.js';

describe('OpenRouterLlmProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts LLM requests that exceed timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          });
        });
      }),
    );

    const provider = new OpenRouterLlmProvider({
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 20,
    });

    await expect(provider.complete('hola')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});

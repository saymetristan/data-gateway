export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'mock-embedding';
  readonly dimensions: number;

  constructor(dimensions = 1024) {
    this.dimensions = dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text, index) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] = ((text.charCodeAt(i % text.length) + index) % 97) / 97;
      }
      return vector;
    }));
  }
}

type OpenRouterEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    model: string;
    dimensions: number;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter embeddings failed (${String(response.status)}): ${body}`);
    }

    const json = (await response.json()) as OpenRouterEmbeddingResponse;
    return json.data.map((item) => item.embedding);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status === 429 && attempt < retries - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Embedding request failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LlmProvider {
  readonly model: string;
  complete(prompt: string): Promise<string>;
}

export class MockLlmProvider implements LlmProvider {
  readonly model = 'mock-llm';

  complete(prompt: string): Promise<string> {
    return Promise.resolve(JSON.stringify({
      summary: `mock enrichment for prompt length ${String(prompt.length)}`,
      tags: ['mock', 'enrichment'],
    }));
  }
}

type OpenRouterChatResponse = {
  choices: Array<{ message: { content: string } }>;
};

export class OpenRouterLlmProvider implements LlmProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; model: string; baseUrl?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter LLM failed (${String(response.status)}): ${body}`);
    }

    const json = (await response.json()) as OpenRouterChatResponse;
    const content = json.choices[0]?.message.content;
    if (!content) {
      throw new Error('OpenRouter LLM returned empty content');
    }
    return content;
  }
}

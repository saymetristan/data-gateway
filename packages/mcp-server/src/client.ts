export type ToolManifest = {
  workspaceId: string;
  generatedAt: string;
  tools: Array<{
    name: string;
    kind: 'search' | 'check_availability';
    description: string;
    entity: string;
    sourceIds: string[];
    mappingVersion: number;
    inputSchema: Record<string, unknown>;
    outputHints?: Record<string, unknown>;
  }>;
};

export type GatewayClientOptions = {
  gatewayUrl: string;
  apiKey: string;
};

export class GatewayClient {
  constructor(private readonly options: GatewayClientOptions) {}

  async fetchManifest(): Promise<ToolManifest> {
    const response = await fetch(`${this.options.gatewayUrl.replace(/\/$/, '')}/tools`, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `Manifest request failed with ${String(response.status)}`);
    }

    return (await response.json()) as ToolManifest;
  }

  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(
      `${this.options.gatewayUrl.replace(/\/$/, '')}/tools/${encodeURIComponent(toolName)}/invoke`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ args }),
      },
    );

    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      [key: string]: unknown;
    };

    if (!response.ok) {
      throw new Error(body.error?.message ?? `Invoke failed with ${String(response.status)}`);
    }

    return body;
  }
}

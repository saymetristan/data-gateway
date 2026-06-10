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

export class GatewayClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GatewayClientError';
  }
}

export class GatewayClient {
  constructor(private readonly options: GatewayClientOptions) {}

  async fetchManifest(): Promise<ToolManifest> {
    const response = await fetch(`${this.options.gatewayUrl.replace(/\/$/, '')}/tools`, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      [key: string]: unknown;
    };
    if (!response.ok) throw toGatewayClientError(response, body, 'Manifest request failed');

    return body as ToolManifest;
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

    if (!response.ok) throw toGatewayClientError(response, body, 'Invoke failed');

    return body;
  }
}

function toGatewayClientError(
  response: Response,
  body: { error?: { code?: string; message?: string } },
  fallback: string,
): GatewayClientError {
  return new GatewayClientError(
    body.error?.message ?? `${fallback} with ${String(response.status)}`,
    response.status,
    body.error?.code,
  );
}

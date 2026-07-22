import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GatewayClientError, type GatewayClient } from './client.js';
import { jsonSchemaToZodShape } from './schema-to-zod.js';

/** Calibrated confidence floor — never absolute RRF score magnitude. */
export const WEAK_SEARCH_CONFIDENCE_THRESHOLD = 0.45;

type WhaapyToolEnvelope = {
  ok: boolean;
  status: 'success' | 'needs_more_info' | 'failed';
  data?: unknown;
  errors?: Array<{
    code: string;
    message: string;
    message_es: string;
    retryable: boolean;
  }>;
  nextQuestion?: string;
  toolName: string;
  safety: 'read_only';
  durationMs: number;
};

export async function createGatewayMcpServer(client: GatewayClient): Promise<McpServer> {
  const server = new McpServer(
    { name: 'data-gateway', version: '0.0.1' },
    {
      instructions:
        'Tools compiladas desde mappings validados del Data Gateway. Usa search_* para búsquedas y check_availability_* para verificar stock/disponibilidad por identificador.',
    },
  );

  const manifest = await client.fetchManifest();
  for (const tool of manifest.tools) {
    const inputSchema = jsonSchemaToZodShape(tool.inputSchema);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
      },
      async (args) => {
        const startedAt = Date.now();
        try {
          const result = await client.invokeTool(tool.name, args as Record<string, unknown>);
          const envelope = toSuccessEnvelope(tool.name, result, Date.now() - startedAt);
          return {
            content: [{ type: 'text', text: JSON.stringify(envelope) }],
            isError: envelope.status !== 'success',
          };
        } catch (error) {
          const envelope = toErrorEnvelope(tool.name, error, Date.now() - startedAt);
          return {
            content: [{ type: 'text', text: JSON.stringify(envelope) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

function toSuccessEnvelope(
  toolName: string,
  data: unknown,
  durationMs: number,
): WhaapyToolEnvelope {
  if (isEmptySearchResult(data)) {
    return {
      ok: false,
      status: 'needs_more_info',
      data,
      nextQuestion:
        'No encontré resultados con esos datos. ¿Me compartes más detalle, otro identificador o una característica diferente?',
      toolName,
      safety: 'read_only',
      durationMs,
    };
  }

  if (isWeakSearchResult(data)) {
    return {
      ok: false,
      status: 'needs_more_info',
      data,
      nextQuestion:
        'Encontré coincidencias débiles que pueden no ser lo que buscas. ¿Me das el nombre exacto del producto (por ejemplo Aida, cuadrillé, etamina) o un SKU?',
      toolName,
      safety: 'read_only',
      durationMs,
    };
  }

  return {
    ok: true,
    status: 'success',
    data,
    toolName,
    safety: 'read_only',
    durationMs,
  };
}

function isEmptySearchResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const maybeResult = data as { kind?: unknown; results?: unknown };
  return (
    maybeResult.kind === 'search' &&
    Array.isArray(maybeResult.results) &&
    maybeResult.results.length === 0
  );
}

/**
 * Non-empty search with calibrated low confidence is not a hard success.
 * Downstream middleware should treat needs_more_info as a signal to ask the
 * customer for a distinctive term or retry with a shorter query.
 */
export function isWeakSearchResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const maybeResult = data as {
    kind?: unknown;
    results?: unknown;
    confidence?: unknown;
  };
  if (maybeResult.kind !== 'search') return false;
  if (!Array.isArray(maybeResult.results) || maybeResult.results.length === 0) {
    return false;
  }
  if (typeof maybeResult.confidence !== 'number') return false;
  return maybeResult.confidence < WEAK_SEARCH_CONFIDENCE_THRESHOLD;
}

function toErrorEnvelope(toolName: string, error: unknown, durationMs: number): WhaapyToolEnvelope {
  const message = error instanceof Error ? error.message : 'Tool invocation failed';
  const code = error instanceof GatewayClientError ? (error.code ?? `http_${String(error.status)}`) : 'tool_failed';
  const retryable = error instanceof GatewayClientError ? error.status === 429 || error.status >= 500 : true;

  return {
    ok: false,
    status: 'failed',
    errors: [
      {
        code,
        message,
        message_es: translateErrorMessage(error, message),
        retryable,
      },
    ],
    toolName,
    safety: 'read_only',
    durationMs,
  };
}

function translateErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof GatewayClientError) {
    if (error.status === 401) return 'La API key del Data Gateway es inválida o no fue enviada.';
    if (error.status === 403) return 'La API key no tiene permisos suficientes para usar esta herramienta.';
    if (error.status === 422) return 'Los argumentos enviados a la herramienta no son válidos.';
    if (error.status === 429) return 'Se alcanzó el límite de uso de la API. Intenta de nuevo en unos segundos.';
    if (error.status >= 500) return 'El sistema externo no respondió correctamente. Intenta más tarde o transfiere a humano.';
  }
  return fallback;
}

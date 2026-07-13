import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withWorkspaceContext } from '../db/rls.js';
import { sources, workspaces } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { LlmProvider } from '../providers/llm.js';
import type { MappingDocument } from '../schemas/mapping.js';
import type { ToolDefinition, ToolInvokeResponse, ToolManifest } from '../schemas/tools.js';
import { compileToolsForEntity, mergeToolDefinitions } from '../tools/compiler.js';
import { toolArgsToQuery } from '../tools/args-to-query.js';
import { validateToolArgs } from '../tools/validate-args.js';
import { getActiveMapping } from './mappings.js';
import { getSourceProfile } from './profile.js';
import { executeQuery } from './query.js';

export async function getToolManifest(db: Database, workspaceId: string): Promise<ToolManifest> {
  return withWorkspaceContext(db, workspaceId, async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) {
      throw GatewayError.notFound('Workspace not found');
    }

    const rows = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.workspaceId, workspaceId), eq(sources.maturityStatus, 'agent_ready')));

    const compiled: ToolDefinition[] = [];
    const warnings: string[] = [];
    for (const source of rows) {
      try {
        const mapping = await getActiveMapping(tx, source.id);
        const profile = await getSourceProfile(tx, source.id);
        const document = mapping.document as MappingDocument;

        for (const entity of document.entities) {
          compiled.push(
            ...compileToolsForEntity({
              entity,
              profile,
              mappingVersion: mapping.version,
              sourceIds: [source.id],
              workspaceName: workspace.name,
              sourceName: source.name,
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        warnings.push(`Source "${source.name}" skipped while compiling tools: ${message}`);
      }
    }

    return {
      workspaceId,
      generatedAt: new Date().toISOString(),
      warnings,
      tools: mergeToolDefinitions(compiled),
    };
  });
}

export type InvokeToolInput = {
  db: Database;
  workspaceId: string;
  apiKeyId?: string;
  toolName: string;
  args: Record<string, unknown>;
  embeddingProvider: EmbeddingProvider;
  llmProvider?: LlmProvider;
  softDeadlineMs?: number;
  hardTimeoutMs?: number;
  enableSynonymExpansion?: boolean;
};

export async function invokeTool(input: InvokeToolInput): Promise<ToolInvokeResponse> {
  const manifest = await getToolManifest(input.db, input.workspaceId);
  const tool = manifest.tools.find((item) => item.name === input.toolName);
  if (!tool) {
    throw GatewayError.notFound(`Tool "${input.toolName}" not found`);
  }

  const validation = validateToolArgs(tool, input.args);
  if (!validation.success) {
    throw GatewayError.unprocessable('Invalid tool arguments', { message: validation.error });
  }

  if (tool.kind === 'check_availability') {
    return invokeAvailabilityTool(input, tool, validation.data);
  }

  return invokeSearchTool(input, tool, validation.data);
}

async function invokeSearchTool(
  input: InvokeToolInput,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ToolInvokeResponse> {
  const translated = toolArgsToQuery(tool, args);
  const response = await executeQuery({
    db: input.db,
    workspaceId: input.workspaceId,
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    request: translated.request,
    presetFilters: translated.presetFilters,
    requiredMaturity: 'agent_ready',
    allowedSourceIds: tool.sourceIds,
    embeddingProvider: input.embeddingProvider,
    ...(input.llmProvider ? { llmProvider: input.llmProvider } : {}),
    ...(input.softDeadlineMs !== undefined ? { softDeadlineMs: input.softDeadlineMs } : {}),
    ...(input.hardTimeoutMs !== undefined ? { hardTimeoutMs: input.hardTimeoutMs } : {}),
    ...(input.enableSynonymExpansion !== undefined
      ? { enableSynonymExpansion: input.enableSynonymExpansion }
      : {}),
    logContext: {
      toolName: tool.name,
      mappingVersion: tool.mappingVersion,
    },
  });

  return {
    kind: 'search',
    results: response.results,
    applied_filters: response.applied_filters,
    ...(response.applied_preferences
      ? { applied_preferences: response.applied_preferences }
      : {}),
    query_type: response.query_type,
    confidence: response.confidence,
    sources_used: response.sources_used,
    warnings: response.warnings,
  };
}

async function invokeAvailabilityTool(
  input: InvokeToolInput,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ToolInvokeResponse> {
  const translated = toolArgsToQuery(tool, args);
  // Filtro booleano implícito de la tool (ej. available=true). Si el mapping ya lo
  // impone via defaultFilters, mergeFilters lo dedupe sin conflicto.
  const availabilityField =
    typeof tool.outputHints?.availabilityField === 'string'
      ? tool.outputHints.availabilityField
      : 'available';
  const presetFilters = [
    ...translated.presetFilters,
    { field: availabilityField, op: 'eq' as const, value: true },
  ];
  const response = await executeQuery({
    db: input.db,
    workspaceId: input.workspaceId,
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    request: {
      entity: tool.entity,
      query: ' ',
      limit: 5,
      useLlmFallback: false,
    },
    presetFilters,
    requiredMaturity: 'agent_ready',
    allowedSourceIds: tool.sourceIds,
    embeddingProvider: input.embeddingProvider,
    logContext: {
      toolName: tool.name,
      mappingVersion: tool.mappingVersion,
    },
  });

  return {
    kind: 'check_availability',
    available: response.results.length > 0,
    matches: response.results.map((result) => ({
      id: result.id,
      entity: result.entity,
      data: result.data,
    })),
    warnings: response.warnings,
  };
}

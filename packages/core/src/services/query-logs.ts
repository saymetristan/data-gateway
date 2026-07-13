import { and, desc, eq, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { queryLogs } from '../db/schema/index.js';
import type { QueryLogsListParams, QueryLogsListResponse } from '../schemas/query-logs.js';

export async function listQueryLogs(
  db: Database,
  workspaceId: string,
  params: QueryLogsListParams,
): Promise<QueryLogsListResponse> {
  const conditions = [eq(queryLogs.workspaceId, workspaceId)];

  if (params.from) {
    conditions.push(sql`${queryLogs.createdAt} >= ${params.from}::timestamptz`);
  }
  if (params.to) {
    conditions.push(sql`${queryLogs.createdAt} <= ${params.to}::timestamptz`);
  }
  if (params.queryType) {
    conditions.push(eq(queryLogs.queryType, params.queryType));
  }
  if (params.maxConfidence !== undefined) {
    conditions.push(lte(queryLogs.confidence, params.maxConfidence));
  }
  if (params.sourceId) {
    conditions.push(eq(queryLogs.sourceId, params.sourceId));
  }
  if (params.onlyErrors) {
    conditions.push(isNotNull(queryLogs.error));
  }
  if (params.cursor) {
    conditions.push(lt(queryLogs.createdAt, new Date(params.cursor)));
  }

  const rows = await db
    .select()
    .from(queryLogs)
    .where(and(...conditions))
    .orderBy(desc(queryLogs.createdAt))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;

  return {
    logs: page.map((row) => ({
      id: row.id,
      apiKeyId: row.apiKeyId,
      sourceId: row.sourceId,
      rawQuery: row.rawQuery,
      structuredQuery: row.structuredQuery as Record<string, unknown> | null,
      queryType: row.queryType,
      appliedFilters: row.appliedFilters,
      resultsCount: row.resultsCount,
      confidence: row.confidence,
      latencyMs: row.latencyMs,
      warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : null,
      error: row.error,
      metadata:
        row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor:
      hasMore && page.length > 0 ? page[page.length - 1]?.createdAt.toISOString() ?? null : null,
  };
}

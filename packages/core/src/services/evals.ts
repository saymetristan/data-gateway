import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  evalCases,
  evalRuns,
  evalSets,
  mappings,
  records,
  sourceTransitions,
  sources,
  workspaces,
} from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { LlmProvider } from '../providers/llm.js';
import type { CreateEvalCaseInput, CreateEvalSetInput } from '../schemas/evals.js';
import type { NormalizedFilter } from '../schemas/query.js';
import {
  aggregateEvalMetrics,
  countSensitiveLeaks,
  evaluateCase,
  filterMatches,
  precisionAtK,
  toCaseResults,
  type EvalCaseAssertions,
} from '../evals/metrics.js';
import { enqueueJob } from '../queue/boss.js';
import { EVALS_RUN_JOB } from '../queue/jobs.js';
import { executeQuery } from './query.js';
import { getRetrievalPolicyById } from './retrieval-policies.js';
import { getSourceForWorkspace } from './workspaces.js';
import { maybeTransitionSourceMaturity, transitionSourceMaturity } from './maturity.js';

const DEFAULT_EVAL_THRESHOLD = 0.8;
const QUERYABLE_MATURITY = new Set(['indexed', 'validated', 'agent_ready']);

export async function createEvalSet(
  db: Database,
  workspaceId: string,
  input: CreateEvalSetInput,
) {
  if (input.sourceId) {
    await getSourceForWorkspace(db, workspaceId, input.sourceId);
  }

  const existingSet = await getApplicableEvalSetForScope(
    db,
    workspaceId,
    input.sourceId ?? null,
  );
  if (existingSet) {
    throw GatewayError.conflict(
      input.sourceId
        ? 'Eval set already exists for source'
        : 'Global eval set already exists for workspace',
    );
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) {
    throw GatewayError.notFound('Workspace not found');
  }

  const settings = workspace.settings as Record<string, unknown>;
  const workspaceThreshold =
    typeof settings.evalThreshold === 'number' ? settings.evalThreshold : DEFAULT_EVAL_THRESHOLD;

  const [created] = await db
    .insert(evalSets)
    .values({
      workspaceId,
      sourceId: input.sourceId ?? null,
      name: input.name,
      description: input.description ?? null,
      threshold: input.threshold ?? workspaceThreshold,
    })
    .returning();

  if (!created) {
    throw GatewayError.internal('Failed to create eval set');
  }

  return created;
}

export async function createEvalCase(
  db: Database,
  workspaceId: string,
  evalSetId: string,
  input: CreateEvalCaseInput,
) {
  const evalSet = await getEvalSetForWorkspace(db, workspaceId, evalSetId);

  const [created] = await db
    .insert(evalCases)
    .values({
      evalSetId: evalSet.id,
      query: input.query,
      expectedResultIds: input.expectedExternalIds ?? null,
      mustApplyFilters: input.mustApplyFilters ?? null,
      mustNotContainFields: input.mustNotContainFields ?? null,
      mustRankAbove: input.mustRankAbove ?? null,
      expectedTopIds: input.expectedTopIds ?? null,
      mustApplyPreferences: input.mustApplyPreferences ?? null,
    })
    .returning();

  if (!created) {
    throw GatewayError.internal('Failed to create eval case');
  }

  return created;
}

export async function deleteEvalCase(
  db: Database,
  workspaceId: string,
  evalSetId: string,
  evalCaseId: string,
) {
  const evalSet = await getEvalSetForWorkspace(db, workspaceId, evalSetId);

  const [deleted] = await db
    .delete(evalCases)
    .where(and(eq(evalCases.id, evalCaseId), eq(evalCases.evalSetId, evalSet.id)))
    .returning();

  if (!deleted) {
    throw GatewayError.notFound('Eval case not found');
  }

  return deleted;
}

export async function listEvalSets(db: Database, workspaceId: string) {
  return db.select().from(evalSets).where(eq(evalSets.workspaceId, workspaceId));
}

export async function getEvalSetWithCases(
  db: Database,
  workspaceId: string,
  evalSetId: string,
) {
  const evalSet = await getEvalSetForWorkspace(db, workspaceId, evalSetId);
  const cases = await db
    .select()
    .from(evalCases)
    .where(eq(evalCases.evalSetId, evalSet.id));

  return { ...evalSet, cases };
}

export async function queueEvalRun(
  db: Database,
  workspaceId: string,
  evalSetId: string,
  connectionString: string,
  retrievalPolicyId?: string,
): Promise<{ runId: string; jobId: string | null }> {
  const evalSet = await getEvalSetWithCases(db, workspaceId, evalSetId);
  if (evalSet.cases.length === 0) {
    throw GatewayError.conflict('Eval set has no cases');
  }

  const queryableSources = await listQueryableSources(db, workspaceId, evalSet.sourceId ?? undefined);
  if (queryableSources.length === 0) {
    throw GatewayError.conflict('No queryable sources found for workspace');
  }
  if (retrievalPolicyId) {
    const policy = await getRetrievalPolicyById(
      db,
      workspaceId,
      retrievalPolicyId,
    );
    if (!evalSet.sourceId || evalSet.sourceId !== policy.sourceId) {
      throw GatewayError.conflict(
        'Retrieval policy eval requires the source-specific eval set for that source',
      );
    }
  }

  const [run] = await db
    .insert(evalRuns)
    .values({
      evalSetId: evalSet.id,
      retrievalPolicyId: retrievalPolicyId ?? null,
      status: 'running',
      metrics: {},
      passed: [],
      failed: [],
    })
    .returning();

  if (!run) {
    throw GatewayError.internal('Failed to create eval run');
  }

  const jobId = await enqueueJob(connectionString, EVALS_RUN_JOB, {
    evalRunId: run.id,
    workspaceId,
  });

  return { runId: run.id, jobId };
}

export async function getEvalRunForWorkspace(
  db: Database,
  workspaceId: string,
  runId: string,
) {
  const [row] = await db
    .select({
      run: evalRuns,
      evalSet: evalSets,
    })
    .from(evalRuns)
    .innerJoin(evalSets, eq(evalRuns.evalSetId, evalSets.id))
    .where(and(eq(evalRuns.id, runId), eq(evalSets.workspaceId, workspaceId)))
    .limit(1);

  if (!row) {
    throw GatewayError.notFound('Eval run not found');
  }

  return row.run;
}

export async function runEvalSet(
  db: Database,
  evalRunId: string,
  workspaceId: string,
  embeddingProvider: EmbeddingProvider,
  llmProvider?: LlmProvider,
): Promise<void> {
  const [row] = await db
    .select({
      run: evalRuns,
      evalSet: evalSets,
    })
    .from(evalRuns)
    .innerJoin(evalSets, eq(evalRuns.evalSetId, evalSets.id))
    .where(and(eq(evalRuns.id, evalRunId), eq(evalSets.workspaceId, workspaceId)))
    .limit(1);

  if (!row) {
    throw GatewayError.notFound('Eval run not found');
  }

  if (row.run.status !== 'running') {
    return;
  }

  const cases = await db
    .select()
    .from(evalCases)
    .where(eq(evalCases.evalSetId, row.evalSet.id));

  try {
    const executions = [];
    const evaluations = [];
    const forbiddenFieldsPerCase: string[][] = [];
    const evaluatedSourceIds = new Set<string>();

    for (const evalCase of cases) {
      const started = Date.now();
      const response = await executeQuery({
        db,
        workspaceId,
        request: {
          query: evalCase.query,
          limit: 10,
          useLlmFallback: false,
          ...(row.evalSet.sourceId ? { sourceId: row.evalSet.sourceId } : {}),
        },
        embeddingProvider,
        ...(row.run.retrievalPolicyId
          ? { retrievalPolicyId: row.run.retrievalPolicyId }
          : {}),
        ...(llmProvider ? { llmProvider } : {}),
      });
      const latencyMs = Date.now() - started;

      const recordIds = response.results.map((result) => result.id);
      const sourceIds = await resolveSourceIds(db, recordIds);
      for (const sourceId of sourceIds) {
        evaluatedSourceIds.add(sourceId);
      }
      const externalIds = await resolveExternalIds(db, recordIds);
      const assertions: EvalCaseAssertions = {};
      if (evalCase.expectedResultIds) {
        assertions.expectedExternalIds = evalCase.expectedResultIds as string[];
      }
      if (evalCase.expectedTopIds) {
        assertions.expectedTopIds = evalCase.expectedTopIds as string[];
      }
      if (evalCase.mustRankAbove) {
        assertions.mustRankAbove = evalCase.mustRankAbove as Array<{
          higher: string;
          lower: string;
        }>;
      }
      if (evalCase.mustApplyFilters) {
        assertions.mustApplyFilters = evalCase.mustApplyFilters as NormalizedFilter[];
      }
      if (evalCase.mustApplyPreferences) {
        assertions.mustApplyPreferences = evalCase.mustApplyPreferences as NonNullable<
          EvalCaseAssertions['mustApplyPreferences']
        >;
      }
      if (evalCase.mustNotContainFields) {
        assertions.mustNotContainFields = evalCase.mustNotContainFields as string[];
      }

      const execution = {
        caseId: evalCase.id,
        query: evalCase.query,
        resultExternalIds: externalIds,
        appliedFilters: response.applied_filters,
        appliedPreferences: response.applied_preferences ?? [],
        resultData: response.results.map((result) => result.data),
        latencyMs,
        limit: 10,
      };

      const evaluation = evaluateCase(execution, assertions);
      const filterScore =
        assertions.mustApplyFilters?.length
          ? assertions.mustApplyFilters.filter((filter) =>
              filterMatches(filter, response.applied_filters),
            ).length / assertions.mustApplyFilters.length
          : 1;

      executions.push(execution);
      evaluations.push({
        passed: evaluation.passed,
        precision: assertions.expectedExternalIds?.length
          ? precisionAtK(assertions.expectedExternalIds, externalIds, 10)
          : 1,
        filterScore,
        latencyMs,
        reasons: evaluation.reasons,
      });
      forbiddenFieldsPerCase.push(assertions.mustNotContainFields ?? []);
    }

    const caseResults = evaluations.map((item) => ({
      passed: item.passed,
      precision: item.precision,
      filterScore: item.filterScore,
      latencyMs: item.latencyMs,
    }));

    const sensitiveLeaks = countSensitiveLeaks(executions, forbiddenFieldsPerCase);
    const metrics = {
      ...aggregateEvalMetrics({ caseResults, sensitiveLeaks }),
      sourceIds: [...evaluatedSourceIds],
    };
    const { passed, failed } = toCaseResults(
      executions,
      evaluations.map((item) => ({ passed: item.passed, reasons: item.reasons })),
    );

    await db
      .update(evalRuns)
      .set({
        status: 'completed',
        metrics,
        passed,
        failed,
        finishedAt: new Date(),
      })
      .where(eq(evalRuns.id, evalRunId));

    if (
      !row.run.retrievalPolicyId &&
      metrics.score >= row.evalSet.threshold &&
      metrics.sensitiveLeaks === 0
    ) {
      await promoteSourcesAfterEvalPass(db, workspaceId, row.evalSet, evalRunId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Eval run failed';
    await db
      .update(evalRuns)
      .set({
        status: 'failed',
        metrics: { error: message },
        finishedAt: new Date(),
      })
      .where(eq(evalRuns.id, evalRunId));
    throw error;
  }
}

export async function getApplicableEvalSet(
  db: Database,
  workspaceId: string,
  sourceId: string,
) {
  const [sourceSpecific] = await db
    .select()
    .from(evalSets)
    .where(
      and(eq(evalSets.workspaceId, workspaceId), eq(evalSets.sourceId, sourceId)),
    )
    .orderBy(desc(evalSets.updatedAt))
    .limit(1);

  if (sourceSpecific) return sourceSpecific;

  const [workspaceSet] = await db
    .select()
    .from(evalSets)
    .where(and(eq(evalSets.workspaceId, workspaceId), isNull(evalSets.sourceId)))
    .orderBy(desc(evalSets.updatedAt))
    .limit(1);

  return workspaceSet ?? null;
}

export async function getLatestCompletedEvalRun(
  db: Database,
  evalSetId: string,
) {
  const [run] = await db
    .select()
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.evalSetId, evalSetId),
        eq(evalRuns.status, 'completed'),
        isNull(evalRuns.retrievalPolicyId),
      ),
    )
    .orderBy(desc(evalRuns.finishedAt))
    .limit(1);

  return run ?? null;
}

export async function activateSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
) {
  const source = await getSourceForWorkspace(db, workspaceId, sourceId);
  if (source.maturityStatus !== 'validated') {
    throw GatewayError.conflict(`Source must be in validated status (current: ${source.maturityStatus})`);
  }

  const evalSet = await getApplicableEvalSet(db, workspaceId, sourceId);
  if (!evalSet) {
    throw GatewayError.conflict('No eval set configured for source or workspace');
  }

  const latestRun = await getLatestCompletedEvalRun(db, evalSet.id);
  if (!latestRun) {
    throw GatewayError.conflict(
      `No completed eval run found for eval set ${evalSet.id} (threshold ${String(evalSet.threshold)})`,
    );
  }
  const latestRelevantChange = await getLatestEvalRelevantChange(db, sourceId);
  if (latestRun.finishedAt && latestRelevantChange && latestRun.finishedAt < latestRelevantChange) {
    throw GatewayError.conflict(
      `Latest eval run ${latestRun.id} is older than the latest source change`,
    );
  }

  const metrics = latestRun.metrics as { score?: number; sensitiveLeaks?: number };
  const score = metrics.score ?? 0;
  if (score < evalSet.threshold) {
    throw GatewayError.conflict(
      `Latest eval run ${latestRun.id} score ${String(score)} below threshold ${String(evalSet.threshold)}`,
    );
  }
  if ((metrics.sensitiveLeaks ?? 0) > 0) {
    throw GatewayError.conflict(
      `Latest eval run ${latestRun.id} has ${String(metrics.sensitiveLeaks)} sensitive leaks`,
    );
  }

  return transitionSourceMaturity(
    db,
    sourceId,
    'agent_ready',
    `activate_after_eval_run:${latestRun.id}`,
  );
}

async function getLatestEvalRelevantChange(
  db: Database,
  sourceId: string,
): Promise<Date | null> {
  const [mapping] = await db
    .select({ updatedAt: mappings.updatedAt })
    .from(mappings)
    .where(and(eq(mappings.sourceId, sourceId), eq(mappings.status, 'active')))
    .orderBy(desc(mappings.version))
    .limit(1);
  const [indexedTransition] = await db
    .select({ createdAt: sourceTransitions.createdAt })
    .from(sourceTransitions)
    .where(and(eq(sourceTransitions.sourceId, sourceId), eq(sourceTransitions.reason, 'source_reindexed')))
    .orderBy(desc(sourceTransitions.createdAt))
    .limit(1);
  const [latestRecord] = await db
    .select({ updatedAt: records.updatedAt })
    .from(records)
    .where(eq(records.sourceId, sourceId))
    .orderBy(desc(records.updatedAt))
    .limit(1);

  const dates = [mapping?.updatedAt, indexedTransition?.createdAt, latestRecord?.updatedAt].filter(
    (value): value is Date => value instanceof Date,
  );
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

async function getEvalSetForWorkspace(
  db: Database,
  workspaceId: string,
  evalSetId: string,
) {
  const [evalSet] = await db
    .select()
    .from(evalSets)
    .where(and(eq(evalSets.id, evalSetId), eq(evalSets.workspaceId, workspaceId)))
    .limit(1);

  if (!evalSet) {
    throw GatewayError.notFound('Eval set not found');
  }

  return evalSet;
}

async function getApplicableEvalSetForScope(
  db: Database,
  workspaceId: string,
  sourceId: string | null,
) {
  const [evalSet] = await db
    .select()
    .from(evalSets)
    .where(
      sourceId
        ? and(eq(evalSets.workspaceId, workspaceId), eq(evalSets.sourceId, sourceId))
        : and(eq(evalSets.workspaceId, workspaceId), isNull(evalSets.sourceId)),
    )
    .limit(1);

  return evalSet ?? null;
}

async function listQueryableSources(
  db: Database,
  workspaceId: string,
  sourceId?: string,
) {
  const rows = await db
    .select()
    .from(sources)
    .where(
      sourceId
        ? and(eq(sources.workspaceId, workspaceId), eq(sources.id, sourceId))
        : eq(sources.workspaceId, workspaceId),
    );

  return rows.filter((source) => QUERYABLE_MATURITY.has(source.maturityStatus));
}

async function promoteSourcesAfterEvalPass(
  db: Database,
  workspaceId: string,
  evalSet: typeof evalSets.$inferSelect,
  evalRunId: string,
) {
  const targetSources = evalSet.sourceId
    ? [evalSet.sourceId]
    : await resolvePromotableSourcesFromRun(db, evalRunId);

  for (const sourceId of targetSources) {
    await maybeTransitionSourceMaturity(
      db,
      sourceId,
      'validated',
      `eval_run:${evalRunId}`,
      ['indexed'],
    );
  }
}

async function resolvePromotableSourcesFromRun(db: Database, evalRunId: string): Promise<string[]> {
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, evalRunId)).limit(1);
  const metrics = (run?.metrics ?? {}) as { sourceIds?: unknown };
  return Array.isArray(metrics.sourceIds)
    ? metrics.sourceIds.filter((id): id is string => typeof id === 'string')
    : [];
}

async function resolveExternalIds(db: Database, recordIds: string[]): Promise<string[]> {
  if (recordIds.length === 0) return [];

  const rows = await db
    .select({ id: records.id, externalId: records.externalId })
    .from(records)
    .where(inArray(records.id, recordIds));

  const byId = new Map(rows.map((row) => [row.id, row.externalId]));
  return recordIds.map((id) => byId.get(id)).filter((id): id is string => Boolean(id));
}

async function resolveSourceIds(db: Database, recordIds: string[]): Promise<string[]> {
  if (recordIds.length === 0) return [];

  const rows = await db
    .select({ sourceId: records.sourceId })
    .from(records)
    .where(inArray(records.id, recordIds));
  return [...new Set(rows.map((row) => row.sourceId))];
}

export async function seedEvalCasesFromFixture(
  db: Database,
  evalSetId: string,
  cases: CreateEvalCaseInput[],
) {
  for (const evalCase of cases) {
    await db.insert(evalCases).values({
      evalSetId,
      query: evalCase.query,
      expectedResultIds: evalCase.expectedExternalIds ?? null,
      mustApplyFilters: evalCase.mustApplyFilters ?? null,
      mustNotContainFields: evalCase.mustNotContainFields ?? null,
      mustRankAbove: evalCase.mustRankAbove ?? null,
      expectedTopIds: evalCase.expectedTopIds ?? null,
      mustApplyPreferences: evalCase.mustApplyPreferences ?? null,
    });
  }
}

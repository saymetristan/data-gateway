import { Hono } from 'hono';
import {
  createEvalCase,
  createEvalCaseSchema,
  createEvalSet,
  createEvalSetSchema,
  GatewayError,
  getEvalRunForWorkspace,
  getEvalSetWithCases,
  listEvalSets,
  queueEvalRun,
  runEvalSetSchema,
} from '@data-gateway/core';
import type { AppBindings, AppVariables } from '../app.js';
import { requireScope } from '../middleware/auth.js';

export function evalRoutes(deps: AppBindings) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/sets', requireScope('evals:write'), async (c) => {
    const body: unknown = await c.req.json();
    const parsed = createEvalSetSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid eval set payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const created = await createEvalSet(db, workspaceId, parsed.data);

    return c.json(
      {
        id: created.id,
        workspaceId: created.workspaceId,
        sourceId: created.sourceId,
        name: created.name,
        description: created.description,
        threshold: created.threshold,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
      201,
    );
  });

  routes.get('/sets', requireScope('evals:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sets = await listEvalSets(db, workspaceId);
    return c.json(
      sets.map((set) => ({
        id: set.id,
        workspaceId: set.workspaceId,
        sourceId: set.sourceId,
        name: set.name,
        description: set.description,
        threshold: set.threshold,
        createdAt: set.createdAt.toISOString(),
        updatedAt: set.updatedAt.toISOString(),
      })),
    );
  });

  routes.get('/sets/:id', requireScope('evals:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const evalSetId = evalSetIdParam(c.req.param('id'));
    const evalSet = await getEvalSetWithCases(db, workspaceId, evalSetId);

    return c.json({
      id: evalSet.id,
      workspaceId: evalSet.workspaceId,
      sourceId: evalSet.sourceId,
      name: evalSet.name,
      description: evalSet.description,
      threshold: evalSet.threshold,
      createdAt: evalSet.createdAt.toISOString(),
      updatedAt: evalSet.updatedAt.toISOString(),
      cases: evalSet.cases.map((evalCase) => ({
        id: evalCase.id,
        query: evalCase.query,
        expectedExternalIds: evalCase.expectedResultIds,
        mustApplyFilters: evalCase.mustApplyFilters,
        mustNotContainFields: evalCase.mustNotContainFields,
        createdAt: evalCase.createdAt.toISOString(),
      })),
    });
  });

  routes.post('/sets/:id/cases', requireScope('evals:write'), async (c) => {
    const body: unknown = await c.req.json();
    const parsed = createEvalCaseSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid eval case payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const evalSetId = evalSetIdParam(c.req.param('id'));
    const created = await createEvalCase(db, workspaceId, evalSetId, parsed.data);

    return c.json(
      {
        id: created.id,
        evalSetId: created.evalSetId,
        query: created.query,
        expectedExternalIds: created.expectedResultIds,
        mustApplyFilters: created.mustApplyFilters,
        mustNotContainFields: created.mustNotContainFields,
        createdAt: created.createdAt.toISOString(),
      },
      201,
    );
  });

  routes.post('/run', requireScope('evals:write'), async (c) => {
    const body: unknown = await c.req.json();
    const parsed = runEvalSetSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid eval run payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const result = await queueEvalRun(
      db,
      workspaceId,
      parsed.data.evalSetId,
      deps.env.DATABASE_URL,
    );

    return c.json({ runId: result.runId, jobId: result.jobId, status: 'queued' }, 202);
  });

  routes.get('/runs/:id', requireScope('evals:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const runId = runIdParam(c.req.param('id'));
    const run = await getEvalRunForWorkspace(db, workspaceId, runId);
    const stale =
      run.status === 'running' && Date.now() - run.startedAt.getTime() > 15 * 60 * 1000;

    return c.json({
      id: run.id,
      evalSetId: run.evalSetId,
      status: run.status,
      metrics: run.metrics,
      passed: run.passed,
      failed: run.failed,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      stale,
    });
  });

  return routes;
}

function evalSetIdParam(value: string | undefined): string {
  if (!value) {
    throw GatewayError.validation('Missing eval set id');
  }
  return value;
}

function runIdParam(value: string | undefined): string {
  if (!value) {
    throw GatewayError.validation('Missing eval run id');
  }
  return value;
}

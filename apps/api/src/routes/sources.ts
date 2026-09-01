import { Hono } from 'hono';
import { and, count, eq } from 'drizzle-orm';
import {
  createSourceSchema,
  syncSourceSchema,
  createSourceWithValidation,
  createMappingSchema,
  createRetrievalPolicySchema,
  activateRetrievalPolicySchema,
  activateSource,
  activateRetrievalPolicy,
  createRetrievalPolicyDraft,
  createSourceMapping,
  enqueueJob,
  enqueueSourceIndexJob,
  GatewayError,
  getActiveMapping,
  getActiveRetrievalPolicy,
  getApplicableEvalSet,
  getRetrievalPolicyByVersion,
  getSourceForWorkspace,
  getSourceProfile,
  getSourceStatus,
  ingestCsvUpload,
  listRetrievalPolicies,
  recordEmbeddings,
  records,
  queueEvalRun,
  SOURCE_SYNC_EXPIRE_IN_HOURS,
  SOURCE_SYNC_JOB,
  SOURCE_SYNC_SINGLETON_MINUTES,
} from '@data-gateway/core';
import type { AppBindings, AppVariables } from '../app.js';
import { requireScope } from '../middleware/auth.js';

export function sourceRoutes(deps: AppBindings) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/', requireScope('sources:write'), async (c) => {
    const body: unknown = await c.req.json();
    const parsed = createSourceSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid source payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const source = await createSourceWithValidation(
      db,
      workspaceId,
      parsed.data,
      deps.env.CREDENTIALS_ENCRYPTION_KEY,
      deps.env.DATABASE_URL,
      {
        ...(deps.env.PUBLIC_API_URL ? { publicApiUrl: deps.env.PUBLIC_API_URL } : {}),
        ...(deps.env.USE_MOCK_PROVIDERS ? { useMockProviders: true } : {}),
      },
    );

    return c.json(
      {
        id: source.id,
        workspaceId: source.workspaceId,
        type: source.type,
        name: source.name,
        maturityStatus: source.maturityStatus,
        createdAt: source.createdAt.toISOString(),
        updatedAt: source.updatedAt.toISOString(),
      },
      201,
    );
  });

  routes.post('/:id/sync', requireScope('sources:write'), async (c) => {
    const rawBody = await c.req.text();
    let body: unknown = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        throw GatewayError.validation('Invalid JSON body');
      }
    }
    const parsed = syncSourceSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid source sync payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const source = await getSourceForWorkspace(db, workspaceId, sourceId);

    if (source.type !== 'database_url' && source.type !== 'shopify') {
      throw GatewayError.validation('Sync is only supported for database_url and shopify sources');
    }

    const jobId = await enqueueJob(
      deps.env.DATABASE_URL,
      SOURCE_SYNC_JOB,
      {
        sourceId: source.id,
        workspaceId,
        fullSync: source.type === 'shopify' ? false : true,
        indexAfterSync: parsed.data.indexAfterSync,
      },
      {
        singletonKey: `source-sync:${source.id}`,
        singletonMinutes: SOURCE_SYNC_SINGLETON_MINUTES,
        expireInHours: SOURCE_SYNC_EXPIRE_IN_HOURS,
      },
    );

    if (!jobId) {
      throw GatewayError.conflict('A source sync is already queued or running');
    }

    return c.json(
      {
        jobId,
        status: 'queued',
        indexAfterSync: parsed.data.indexAfterSync,
      },
      202,
    );
  });

  routes.post('/:id/upload', requireScope('sources:write'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const source = await getSourceForWorkspace(db, workspaceId, sourceId);

    if (source.type !== 'csv') {
      throw GatewayError.validation('CSV upload is only supported for csv sources');
    }

    const contentType = c.req.header('content-type') ?? '';
    let csvContent = '';

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.file;
      if (typeof file === 'string') {
        csvContent = file;
      } else if (file instanceof File) {
        csvContent = await file.text();
      } else {
        throw GatewayError.validation('Missing CSV file in multipart form field "file"');
      }
    } else {
      csvContent = await c.req.text();
    }

    if (!csvContent.trim()) {
      throw GatewayError.validation('CSV content is empty');
    }

    const result = await ingestCsvUpload(
      db,
      source.id,
      workspaceId,
      csvContent,
      deps.env.DATABASE_URL,
    );

    return c.json(result, 202);
  });

  routes.get('/:id/profile', requireScope('sources:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    await getSourceForWorkspace(db, workspaceId, sourceId);
    const profile = await getSourceProfile(db, sourceId);
    const mapping = await getActiveMapping(db, sourceId).catch((error: unknown) => {
      if (error instanceof GatewayError && error.code === 'conflict') return null;
      throw error;
    });
    if (!mapping) return c.json(profile);

    const sensitiveColumns = new Set<string>();
    const document = mapping.document as {
      entities?: Array<{ fields?: Array<{ sourceColumn?: string; sensitive?: boolean }> }>;
    };
    for (const entity of document.entities ?? []) {
      for (const field of entity.fields ?? []) {
        if (field.sensitive && field.sourceColumn) sensitiveColumns.add(field.sourceColumn);
      }
    }
    const redactedProfile = {
      ...profile,
      tables: profile.tables.map((table) => ({
        ...table,
        columns: table.columns.map((column) =>
          sensitiveColumns.has(column.name) ? { ...column, topValues: [] } : column,
        ),
      })),
    };
    return c.json(redactedProfile);
  });

  routes.get('/:id/retrieval-policies', requireScope('retrieval:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const policies = await listRetrievalPolicies(db, workspaceId, sourceId);
    return c.json(policies.map(serializeRetrievalPolicy));
  });

  routes.get('/:id/retrieval-policies/active', requireScope('retrieval:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const policy = await getActiveRetrievalPolicy(db, workspaceId, sourceId);
    return c.json({ policy: policy ? serializeRetrievalPolicy(policy) : null });
  });

  routes.post('/:id/retrieval-policies', requireScope('retrieval:write'), async (c) => {
    const body: unknown = await c.req.json();
    const parsed = createRetrievalPolicySchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid retrieval policy payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const created = await createRetrievalPolicyDraft(
      db,
      workspaceId,
      sourceId,
      parsed.data,
      c.get('apiKeyId'),
    );
    return c.json(serializeRetrievalPolicy(created), 201);
  });

  routes.post(
    '/:id/retrieval-policies/:version/eval',
    requireScope('retrieval:write'),
    async (c) => {
      const db = c.get('db');
      const workspaceId = c.get('workspaceId');
      const sourceId = sourceIdParam(c.req.param('id'));
      const version = policyVersionParam(c.req.param('version'));
      const policy = await getRetrievalPolicyByVersion(db, workspaceId, sourceId, version);
      const evalSet = await getApplicableEvalSet(db, workspaceId, sourceId);
      if (!evalSet || evalSet.sourceId !== sourceId) {
        throw GatewayError.conflict(
          'A source-specific eval set is required for retrieval policy validation',
        );
      }
      const result = await queueEvalRun(
        db,
        workspaceId,
        evalSet.id,
        deps.env.DATABASE_URL,
        policy.id,
      );
      return c.json(
        {
          runId: result.runId,
          jobId: result.jobId,
          retrievalPolicyVersion: version,
          status: 'queued',
        },
        202,
      );
    },
  );

  routes.post(
    '/:id/retrieval-policies/:version/activate',
    requireScope('retrieval:write'),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => ({}));
      const parsed = activateRetrievalPolicySchema.safeParse(body);
      if (!parsed.success) {
        throw GatewayError.validation(
          'Invalid retrieval policy activation payload',
          parsed.error.flatten(),
        );
      }
      const db = c.get('db');
      const workspaceId = c.get('workspaceId');
      const sourceId = sourceIdParam(c.req.param('id'));
      const version = policyVersionParam(c.req.param('version'));
      const activated = await activateRetrievalPolicy(
        db,
        workspaceId,
        sourceId,
        version,
        parsed.data,
      );
      return c.json(serializeRetrievalPolicy(activated));
    },
  );

  routes.post('/:id/mapping', requireScope('sources:write'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    await getSourceForWorkspace(db, workspaceId, sourceId);

    const body: unknown = await c.req.json();
    const parsed = createMappingSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid mapping payload', parsed.error.flatten());
    }

    const mapping = await createSourceMapping(
      db,
      sourceId,
      workspaceId,
      parsed.data,
      deps.env.DATABASE_URL,
    );
    return c.json(
      {
        id: mapping.id,
        sourceId: mapping.sourceId,
        version: mapping.version,
        status: mapping.status,
        createdAt: mapping.createdAt.toISOString(),
      },
      201,
    );
  });

  routes.post('/:id/index', requireScope('sources:write'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    await getSourceForWorkspace(db, workspaceId, sourceId);
    await getActiveMapping(db, sourceId);

    const jobId = await enqueueSourceIndexJob(deps.env.DATABASE_URL, {
      sourceId,
      workspaceId,
    });

    return c.json({ jobId, status: 'queued' }, 202);
  });

  routes.post('/:id/activate', requireScope('sources:write'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const source = await activateSource(db, workspaceId, sourceId);

    return c.json({
      id: source.id,
      maturityStatus: source.maturityStatus,
      updatedAt: source.updatedAt.toISOString(),
    });
  });

  routes.get('/:id/status', requireScope('sources:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    await getSourceForWorkspace(db, workspaceId, sourceId);
    const activeMapping = await getActiveMapping(db, sourceId);

    const [status, recordCountRows, embeddingCountRows] = await Promise.all([
      getSourceStatus(db, sourceId),
      db.select({ count: count() }).from(records).where(eq(records.sourceId, sourceId)),
      db
        .select({ count: count() })
        .from(recordEmbeddings)
        .innerJoin(records, eq(recordEmbeddings.recordId, records.id))
        .where(
          and(
            eq(records.sourceId, sourceId),
            eq(recordEmbeddings.mappingVersion, activeMapping.version),
            eq(recordEmbeddings.embeddingModel, deps.embeddingProvider.model),
          ),
        ),
    ]);
    const [recordCount] = recordCountRows;
    const [embeddingCount] = embeddingCountRows;

    return c.json({
      ...status,
      counts: {
        raw: status.rawRecords,
        records: recordCount?.count ?? 0,
        embeddings: embeddingCount?.count ?? 0,
      },
    });
  });

  return routes;
}

function sourceIdParam(value: string | undefined): string {
  if (!value) {
    throw GatewayError.validation('Missing source id');
  }
  return value;
}

function policyVersionParam(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    throw GatewayError.validation('Invalid retrieval policy version');
  }
  return parsed;
}

function serializeRetrievalPolicy(policy: {
  id: string;
  workspaceId: string;
  sourceId: string;
  version: number;
  status: string;
  document: unknown;
  createdByApiKeyId: string | null;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: policy.id,
    workspaceId: policy.workspaceId,
    sourceId: policy.sourceId,
    version: policy.version,
    status: policy.status,
    document: policy.document,
    createdByApiKeyId: policy.createdByApiKeyId,
    activatedAt: policy.activatedAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

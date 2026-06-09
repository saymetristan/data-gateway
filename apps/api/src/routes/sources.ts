import { Hono } from 'hono';
import { count, eq } from 'drizzle-orm';
import {
  createSourceSchema,
  createSourceWithValidation,
  createMappingSchema,
  activateSource,
  createSourceMapping,
  enqueueJob,
  GatewayError,
  getActiveMapping,
  getSourceForWorkspace,
  getSourceProfile,
  getSourceStatus,
  ingestCsvUpload,
  recordEmbeddings,
  records,
  sourceRecordsRaw,
  SOURCE_INDEX_JOB,
  SOURCE_SYNC_JOB,
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
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const sourceId = sourceIdParam(c.req.param('id'));
    const source = await getSourceForWorkspace(db, workspaceId, sourceId);

    if (source.type !== 'database_url') {
      throw GatewayError.validation('Sync is only supported for database_url sources');
    }

    const jobId = await enqueueJob(deps.env.DATABASE_URL, SOURCE_SYNC_JOB, {
      sourceId: source.id,
      workspaceId,
      fullSync: true,
    });

    return c.json({ jobId, status: 'queued' }, 202);
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
    return c.json(profile);
  });

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

    const mapping = await createSourceMapping(db, sourceId, workspaceId, parsed.data);
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

    const jobId = await enqueueJob(deps.env.DATABASE_URL, SOURCE_INDEX_JOB, {
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

    const status = await getSourceStatus(db, sourceId);

    const [rawCount] = await db
      .select({ count: count() })
      .from(sourceRecordsRaw)
      .where(eq(sourceRecordsRaw.sourceId, sourceId));
    const [recordCount] = await db
      .select({ count: count() })
      .from(records)
      .where(eq(records.sourceId, sourceId));
    const [embeddingCount] = await db
      .select({ count: count() })
      .from(recordEmbeddings)
      .innerJoin(records, eq(recordEmbeddings.recordId, records.id))
      .where(eq(records.sourceId, sourceId));

    return c.json({
      ...status,
      counts: {
        raw: rawCount?.count ?? 0,
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

import { eq, and, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { workspaces, apiKeys, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import { generateApiKey, hashApiKey } from '../auth/api-keys.js';
import type {
  CreateWorkspaceInput,
  CreateApiKeyInput,
  CreateSourceInput,
} from '../schemas/index.js';

export async function createWorkspace(db: Database, input: CreateWorkspaceInput) {
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, input.slug))
    .limit(1);

  if (existing) {
    throw GatewayError.conflict(`Workspace slug "${input.slug}" already exists`);
  }

  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: input.name,
      slug: input.slug,
      settings: input.settings ?? {},
    })
    .returning();

  if (!workspace) {
    throw GatewayError.internal('Failed to create workspace');
  }

  return workspace;
}

export async function createApiKeyForWorkspace(
  db: Database,
  workspaceId: string,
  input: CreateApiKeyInput,
) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw GatewayError.notFound('Workspace not found');
  }

  const { key, hash, prefix } = generateApiKey();

  const [row] = await db
    .insert(apiKeys)
    .values({
      workspaceId,
      keyHash: hash,
      prefix,
      scopes: input.scopes,
    })
    .returning();

  if (!row) {
    throw GatewayError.internal('Failed to create API key');
  }

  return { row, key };
}

export async function resolveApiKey(db: Database, rawKey: string) {
  const hash = hashApiKey(rawKey);

  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!row) {
    throw GatewayError.unauthorized('Invalid API key');
  }

  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(apiKeys.id, row.id));

  return {
    ...row,
    scopes: row.scopes.length > 0 ? row.scopes : ['*'],
  };
}

export async function createSourceUnsafeForTests(
  db: Database,
  workspaceId: string,
  input: CreateSourceInput,
) {
  const [source] = await db
    .insert(sources)
    .values({
      workspaceId,
      type: input.type,
      name: input.name,
      config: input.config,
      maturityStatus: 'connected',
    })
    .returning();

  if (!source) {
    throw GatewayError.internal('Failed to create source');
  }

  return source;
}

export async function getSourceForWorkspace(
  db: Database,
  workspaceId: string,
  sourceId: string,
) {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);

  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  return source;
}

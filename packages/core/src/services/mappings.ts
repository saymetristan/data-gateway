import { and, eq, desc } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mappings, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { CreateMappingInput } from '../schemas/mapping.js';
import { mappingDocumentSchema } from '../schemas/mapping.js';
import { validateMappingAgainstProfile } from '../mapping/validate.js';
import { getSourceProfile } from './profile.js';

export async function createSourceMapping(
  db: Database,
  sourceId: string,
  workspaceId: string,
  input: CreateMappingInput,
) {
  const parsed = mappingDocumentSchema.parse(input.document);
  const profile = await getSourceProfile(db, sourceId);
  validateMappingAgainstProfile(parsed, profile);

  const [source] = await db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);

  if (!source || source.workspaceId !== workspaceId) {
    throw GatewayError.notFound('Source not found');
  }

  const [latest] = await db
    .select({ version: mappings.version })
    .from(mappings)
    .where(eq(mappings.sourceId, sourceId))
    .orderBy(desc(mappings.version))
    .limit(1);

  const nextVersion = (latest?.version ?? 0) + 1;

  await db
    .update(mappings)
    .set({ status: 'draft', updatedAt: new Date() })
    .where(and(eq(mappings.sourceId, sourceId), eq(mappings.status, 'active')));

  const [created] = await db
    .insert(mappings)
    .values({
      sourceId,
      version: nextVersion,
      document: parsed,
      status: 'active',
    })
    .returning();

  if (!created) {
    throw GatewayError.internal('Failed to create mapping');
  }

  if (source.maturityStatus === 'profiled' || source.maturityStatus === 'connected') {
    await db
      .update(sources)
      .set({ maturityStatus: 'mapped', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
  }

  return created;
}

export async function getActiveMapping(db: Database, sourceId: string) {
  const [mapping] = await db
    .select()
    .from(mappings)
    .where(and(eq(mappings.sourceId, sourceId), eq(mappings.status, 'active')))
    .orderBy(desc(mappings.version))
    .limit(1);

  if (!mapping) {
    throw GatewayError.conflict('Active mapping not found for source');
  }

  return mapping;
}

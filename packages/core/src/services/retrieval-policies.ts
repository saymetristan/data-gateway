import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  evalRuns,
  evalSets,
  sourceRetrievalPolicies,
} from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type {
  ActivateRetrievalPolicyInput,
  CreateRetrievalPolicyInput,
  RetrievalPolicyDocument,
} from '../schemas/retrieval-policy.js';
import { retrievalPolicyDocumentSchema } from '../schemas/retrieval-policy.js';
import { getActiveMapping } from './mappings.js';
import { getSourceForWorkspace } from './workspaces.js';

export async function createRetrievalPolicyDraft(
  db: Database,
  workspaceId: string,
  sourceId: string,
  input: CreateRetrievalPolicyInput,
  apiKeyId?: string,
) {
  await getSourceForWorkspace(db, workspaceId, sourceId);
  const mapping = await getActiveMapping(db, sourceId);
  const mappingDocument = mapping.document as {
    entities?: Array<{ entity?: string }>;
  };
  const allowedEntities = new Set(
    (mappingDocument.entities ?? [])
      .map((entity) => entity.entity)
      .filter((entity): entity is string => typeof entity === 'string'),
  );
  for (const entity of input.document.entities) {
    if (!allowedEntities.has(entity.entity)) {
      throw GatewayError.validation(
        `Retrieval policy entity "${entity.entity}" is not present in the active mapping`,
      );
    }
  }

  return db.transaction(async (tx) => {
    await lockSourcePolicy(tx, sourceId);
    const [active] = await tx
      .select({ version: sourceRetrievalPolicies.version })
      .from(sourceRetrievalPolicies)
      .where(
        and(
          eq(sourceRetrievalPolicies.workspaceId, workspaceId),
          eq(sourceRetrievalPolicies.sourceId, sourceId),
          eq(sourceRetrievalPolicies.status, 'active'),
        ),
      )
      .limit(1);

    assertExpectedActiveVersion(input.expectedActiveVersion, active?.version);

    const [latest] = await tx
      .select({ version: sourceRetrievalPolicies.version })
      .from(sourceRetrievalPolicies)
      .where(
        and(
          eq(sourceRetrievalPolicies.workspaceId, workspaceId),
          eq(sourceRetrievalPolicies.sourceId, sourceId),
        ),
      )
      .orderBy(desc(sourceRetrievalPolicies.version))
      .limit(1);

    const [created] = await tx
      .insert(sourceRetrievalPolicies)
      .values({
        workspaceId,
        sourceId,
        version: (latest?.version ?? 0) + 1,
        status: 'draft',
        document: input.document,
        createdByApiKeyId: apiKeyId ?? null,
      })
      .returning();

    if (!created) {
      throw GatewayError.internal('Failed to create retrieval policy draft');
    }
    return created;
  });
}

export async function listRetrievalPolicies(
  db: Database,
  workspaceId: string,
  sourceId: string,
) {
  await getSourceForWorkspace(db, workspaceId, sourceId);
  return db
    .select()
    .from(sourceRetrievalPolicies)
    .where(
      and(
        eq(sourceRetrievalPolicies.workspaceId, workspaceId),
        eq(sourceRetrievalPolicies.sourceId, sourceId),
      ),
    )
    .orderBy(desc(sourceRetrievalPolicies.version));
}

export async function getActiveRetrievalPolicy(
  db: Database,
  workspaceId: string,
  sourceId: string,
) {
  await getSourceForWorkspace(db, workspaceId, sourceId);
  const [policy] = await db
    .select()
    .from(sourceRetrievalPolicies)
    .where(
      and(
        eq(sourceRetrievalPolicies.workspaceId, workspaceId),
        eq(sourceRetrievalPolicies.sourceId, sourceId),
        eq(sourceRetrievalPolicies.status, 'active'),
      ),
    )
    .limit(1);
  return policy ?? null;
}

export async function getRetrievalPolicyByVersion(
  db: Database,
  workspaceId: string,
  sourceId: string,
  version: number,
) {
  await getSourceForWorkspace(db, workspaceId, sourceId);
  const [policy] = await db
    .select()
    .from(sourceRetrievalPolicies)
    .where(
      and(
        eq(sourceRetrievalPolicies.workspaceId, workspaceId),
        eq(sourceRetrievalPolicies.sourceId, sourceId),
        eq(sourceRetrievalPolicies.version, version),
      ),
    )
    .limit(1);
  if (!policy) throw GatewayError.notFound('Retrieval policy version not found');
  return policy;
}

export async function getRetrievalPolicyById(
  db: Database,
  workspaceId: string,
  policyId: string,
) {
  const [policy] = await db
    .select()
    .from(sourceRetrievalPolicies)
    .where(
      and(
        eq(sourceRetrievalPolicies.workspaceId, workspaceId),
        eq(sourceRetrievalPolicies.id, policyId),
      ),
    )
    .limit(1);
  if (!policy) throw GatewayError.notFound('Retrieval policy not found');
  return policy;
}

export async function getActiveRetrievalPoliciesForSources(
  db: Database,
  workspaceId: string,
  sourceIds: string[],
) {
  if (sourceIds.length === 0) return new Map<string, ActiveRetrievalPolicy>();
  const rows = await db
    .select()
    .from(sourceRetrievalPolicies)
    .where(
      and(
        eq(sourceRetrievalPolicies.workspaceId, workspaceId),
        inArray(sourceRetrievalPolicies.sourceId, sourceIds),
        eq(sourceRetrievalPolicies.status, 'active'),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.sourceId,
      {
        id: row.id,
        sourceId: row.sourceId,
        version: row.version,
        document: retrievalPolicyDocumentSchema.parse(row.document),
      },
    ]),
  );
}

export async function activateRetrievalPolicy(
  db: Database,
  workspaceId: string,
  sourceId: string,
  version: number,
  input: ActivateRetrievalPolicyInput = {},
) {
  await getSourceForWorkspace(db, workspaceId, sourceId);
  const target = await getRetrievalPolicyByVersion(db, workspaceId, sourceId, version);
  if (target.status === 'active') return target;

  const [validation] = await db
    .select({
      run: evalRuns,
      threshold: evalSets.threshold,
    })
    .from(evalRuns)
    .innerJoin(evalSets, eq(evalRuns.evalSetId, evalSets.id))
    .where(
      and(
        eq(evalRuns.retrievalPolicyId, target.id),
        eq(evalRuns.status, 'completed'),
        eq(evalSets.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(evalRuns.finishedAt))
    .limit(1);

  if (!validation) {
    throw GatewayError.conflict(
      `Retrieval policy version ${String(version)} has no completed eval run`,
    );
  }
  const metrics = validation.run.metrics as {
    score?: number;
    sensitiveLeaks?: number;
  };
  if ((metrics.score ?? 0) < validation.threshold) {
    throw GatewayError.conflict(
      `Retrieval policy eval score ${String(metrics.score ?? 0)} below threshold ${String(validation.threshold)}`,
    );
  }
  if ((metrics.sensitiveLeaks ?? 0) > 0) {
    throw GatewayError.conflict('Retrieval policy eval has sensitive field leaks');
  }

  return db.transaction(async (tx) => {
    await lockSourcePolicy(tx, sourceId);
    const [active] = await tx
      .select()
      .from(sourceRetrievalPolicies)
      .where(
        and(
          eq(sourceRetrievalPolicies.workspaceId, workspaceId),
          eq(sourceRetrievalPolicies.sourceId, sourceId),
          eq(sourceRetrievalPolicies.status, 'active'),
        ),
      )
      .limit(1);

    assertExpectedActiveVersion(input.expectedActiveVersion, active?.version);

    if (active) {
      await tx
        .update(sourceRetrievalPolicies)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(sourceRetrievalPolicies.id, active.id));
    }

    const [activated] = await tx
      .update(sourceRetrievalPolicies)
      .set({
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceRetrievalPolicies.id, target.id),
          eq(sourceRetrievalPolicies.workspaceId, workspaceId),
          eq(sourceRetrievalPolicies.sourceId, sourceId),
        ),
      )
      .returning();

    if (!activated) {
      throw GatewayError.internal('Failed to activate retrieval policy');
    }
    return activated;
  });
}

export type ActiveRetrievalPolicy = {
  id: string;
  sourceId: string;
  version: number;
  document: RetrievalPolicyDocument;
};

export type SynonymConfig = {
  version: string;
  entries: Record<string, string[]>;
};

/** Policy entries replace legacy mapping synonyms for that entity. */
export function resolveEntitySynonyms(
  policy: ActiveRetrievalPolicy | undefined,
  entity: string,
  legacy: SynonymConfig | undefined,
): SynonymConfig | undefined {
  const policyEntity = policy?.document.entities.find(
    (item) => item.entity === entity,
  );
  if (!policyEntity || !policy) return legacy;
  return {
    version: `retrieval-policy-v${String(policy.version)}`,
    entries: policyEntity.synonyms.entries,
  };
}

function assertExpectedActiveVersion(
  expected: number | undefined,
  actual: number | undefined,
): void {
  if (expected === undefined) return;
  const current = actual ?? 0;
  if (expected !== current) {
    throw GatewayError.conflict(
      `Retrieval policy active version conflict: expected ${String(expected)}, current ${String(current)}`,
    );
  }
}

async function lockSourcePolicy(
  db: Parameters<Parameters<Database['transaction']>[0]>[0],
  sourceId: string,
): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`);
}

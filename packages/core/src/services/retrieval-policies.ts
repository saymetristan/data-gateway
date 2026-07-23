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
    entities?: Array<{
      entity?: string;
      fields?: Array<{
        name?: string;
        sensitive?: boolean;
        filterable?: boolean;
        visible?: boolean;
      }>;
    }>;
  };
  const entitiesByName = new Map(
    (mappingDocument.entities ?? [])
      .filter((entity): entity is { entity: string; fields?: Array<{ name?: string; sensitive?: boolean; filterable?: boolean; visible?: boolean }> } =>
        typeof entity.entity === 'string',
      )
      .map((entity) => [entity.entity, entity]),
  );
  for (const entity of input.document.entities) {
    const mappingEntity = entitiesByName.get(entity.entity);
    if (!mappingEntity) {
      throw GatewayError.validation(
        `Retrieval policy entity "${entity.entity}" is not present in the active mapping`,
      );
    }
    const fieldsByName = new Map(
      (mappingEntity.fields ?? [])
        .filter((field): field is { name: string; sensitive?: boolean; filterable?: boolean; visible?: boolean } =>
          typeof field.name === 'string',
        )
        .map((field) => [field.name, field]),
    );
    for (const fieldPolicy of entity.fields) {
      const mappingField = fieldsByName.get(fieldPolicy.field);
      if (!mappingField) {
        throw GatewayError.validation(
          `Retrieval policy field "${fieldPolicy.field}" is not present in mapping entity "${entity.entity}"`,
        );
      }
      if (mappingField.sensitive) {
        throw GatewayError.validation(
          `Retrieval policy field "${fieldPolicy.field}" is sensitive and cannot be configured`,
        );
      }
      if (mappingField.visible === false) {
        throw GatewayError.validation(
          `Retrieval policy field "${fieldPolicy.field}" is not visible and cannot be configured`,
        );
      }
      if (mappingField.filterable === false) {
        throw GatewayError.validation(
          `Retrieval policy field "${fieldPolicy.field}" is not filterable`,
        );
      }
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

export type ActiveRetrievalPoliciesResult = {
  policies: Map<string, ActiveRetrievalPolicy>;
  warnings: string[];
};

export type StoredRetrievalPolicyRow = {
  id: string;
  sourceId: string;
  version: number;
  document: unknown;
};

/** Fail-open parse for persisted active policies used at query-time. */
export function parseStoredActivePolicy(
  row: StoredRetrievalPolicyRow,
): { policy: ActiveRetrievalPolicy } | { warning: string } {
  const parsed = retrievalPolicyDocumentSchema.safeParse(row.document);
  if (!parsed.success) {
    return {
      warning: `Active retrieval policy v${String(row.version)} for source ${row.sourceId} is invalid and was ignored; using mapping synonyms`,
    };
  }
  return {
    policy: {
      id: row.id,
      sourceId: row.sourceId,
      version: row.version,
      document: parsed.data,
    },
  };
}

/**
 * Loads active policies for query-time. Invalid persisted documents are omitted
 * (fail-open) so a corrupt policy never turns every search into HTTP 500.
 */
export async function getActiveRetrievalPoliciesForSources(
  db: Database,
  workspaceId: string,
  sourceIds: string[],
): Promise<ActiveRetrievalPoliciesResult> {
  if (sourceIds.length === 0) {
    return { policies: new Map(), warnings: [] };
  }
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

  const policies = new Map<string, ActiveRetrievalPolicy>();
  const warnings: string[] = [];
  for (const row of rows) {
    const result = parseStoredActivePolicy(row);
    if ('warning' in result) {
      warnings.push(result.warning);
      continue;
    }
    policies.set(row.sourceId, result.policy);
  }
  return { policies, warnings };
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
  if (!policyEntity?.synonyms || !policy) return legacy;
  return {
    version: `retrieval-policy-v${String(policy.version)}`,
    entries: policyEntity.synonyms.entries,
  };
}

export type ResolvedFieldPolicy = {
  aliases: string[];
  valueAliases: Record<string, string[]>;
  implicitBehavior?: 'filter' | 'prefer' | 'search';
  match?: 'eq' | 'contains' | 'containsAny' | 'containsAll';
  boost?: number;
};

/** Field policy overlays mapping retrieval defaults for query-time behavior. */
export function resolveFieldPolicy(
  policy: ActiveRetrievalPolicy | undefined,
  entity: string,
  field: string,
): ResolvedFieldPolicy | undefined {
  const policyEntity = policy?.document.entities.find((item) => item.entity === entity);
  const fieldPolicy = policyEntity?.fields.find((item) => item.field === field);
  if (!fieldPolicy) return undefined;
  return {
    aliases: fieldPolicy.aliases,
    valueAliases: fieldPolicy.valueAliases ?? {},
    ...(fieldPolicy.implicitBehavior ? { implicitBehavior: fieldPolicy.implicitBehavior } : {}),
    ...(fieldPolicy.match ? { match: fieldPolicy.match } : {}),
    ...(fieldPolicy.boost !== undefined ? { boost: fieldPolicy.boost } : {}),
  };
}

export function resolveEntityRrf(
  policy: ActiveRetrievalPolicy | undefined,
  entity: string,
  legacy?: { lexicalWeight: number; vectorWeight: number },
): { lexicalWeight: number; vectorWeight: number } | undefined {
  const policyEntity = policy?.document.entities.find((item) => item.entity === entity);
  if (policyEntity?.rrf) return policyEntity.rrf;
  return legacy;
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

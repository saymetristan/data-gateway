import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sourceTransitions, sources } from '../db/schema/index.js';
import type { Source } from '../db/schema/sources.js';
import { GatewayError } from '../errors/gateway-error.js';

export type MaturityStatus = Source['maturityStatus'];

const ALLOWED_TRANSITIONS: Record<MaturityStatus, MaturityStatus[]> = {
  connected: ['profiled', 'mapped'],
  profiled: ['mapped'],
  mapped: ['indexed'],
  indexed: ['validated', 'indexed'],
  validated: ['agent_ready', 'indexed', 'mapped'],
  agent_ready: ['indexed', 'mapped'],
};

export function isTransitionAllowed(from: MaturityStatus, to: MaturityStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export async function transitionSourceMaturity(
  db: Database,
  sourceId: string,
  to: MaturityStatus,
  reason: string,
): Promise<Source> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  if (source.maturityStatus === to) {
    return source;
  }

  if (!isTransitionAllowed(source.maturityStatus, to)) {
    throw GatewayError.conflict(
      `Invalid maturity transition from "${source.maturityStatus}" to "${to}"`,
    );
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(sources)
      .set({ maturityStatus: to, updatedAt: new Date() })
      .where(eq(sources.id, sourceId))
      .returning();

    if (!updated) {
      throw GatewayError.internal('Failed to update source maturity');
    }

    await tx.insert(sourceTransitions).values({
      sourceId,
      fromStatus: source.maturityStatus,
      toStatus: to,
      reason,
    });

    return updated;
  });
}

export async function maybeTransitionSourceMaturity(
  db: Database,
  sourceId: string,
  to: MaturityStatus,
  reason: string,
  allowedFrom: MaturityStatus[],
): Promise<Source | null> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source || !allowedFrom.includes(source.maturityStatus)) {
    return null;
  }
  return transitionSourceMaturity(db, sourceId, to, reason);
}

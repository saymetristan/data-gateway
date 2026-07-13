import { createHash } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { queryEmbeddingCache } from '../db/schema/query-embedding-cache.js';

export const DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_L1_MAX_ENTRIES = 512;

export type CacheLayer = 'l1' | 'l2' | 'miss';

export type QueryEmbeddingCacheHit = {
  embedding: number[];
  layer: Exclude<CacheLayer, 'miss'>;
};

type L1Entry = {
  embedding: number[];
  expiresAt: number;
};

export type QueryEmbeddingCacheOptions = {
  ttlMs?: number;
  l1MaxEntries?: number;
};

/**
 * Normalize query text for cache key stability:
 * NFKC, lowercase, collapse whitespace, strip combining marks.
 */
export function normalizeQueryForEmbeddingCache(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildQueryEmbeddingCacheHash(input: {
  model: string;
  dimensions: number;
  query: string;
}): string {
  const normalized = normalizeQueryForEmbeddingCache(input.query);
  const payload = `${input.model}\n${String(input.dimensions)}\n${normalized}`;
  return createHash('sha256').update(payload).digest('hex');
}

export class QueryEmbeddingCache {
  private readonly ttlMs: number;
  private readonly l1MaxEntries: number;
  private readonly l1 = new Map<string, L1Entry>();
  private readonly inflight = new Map<string, Promise<number[]>>();

  constructor(options: QueryEmbeddingCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS;
    this.l1MaxEntries = options.l1MaxEntries ?? DEFAULT_L1_MAX_ENTRIES;
  }

  private l1Key(workspaceId: string, queryHash: string, model: string, dims: number): string {
    return `${workspaceId}:${queryHash}:${model}:${String(dims)}`;
  }

  getFromL1(
    workspaceId: string,
    queryHash: string,
    model: string,
    dims: number,
    now = Date.now(),
  ): number[] | null {
    const key = this.l1Key(workspaceId, queryHash, model, dims);
    const entry = this.l1.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.l1.delete(key);
      return null;
    }
    // LRU touch
    this.l1.delete(key);
    this.l1.set(key, entry);
    return entry.embedding;
  }

  setL1(
    workspaceId: string,
    queryHash: string,
    model: string,
    dims: number,
    embedding: number[],
    now = Date.now(),
  ): void {
    const key = this.l1Key(workspaceId, queryHash, model, dims);
    if (this.l1.has(key)) this.l1.delete(key);
    this.l1.set(key, { embedding, expiresAt: now + this.ttlMs });
    while (this.l1.size > this.l1MaxEntries) {
      const oldest = this.l1.keys().next().value;
      if (oldest === undefined) break;
      this.l1.delete(oldest);
    }
  }

  async getFromL2(
    db: Database,
    workspaceId: string,
    queryHash: string,
    model: string,
    dims: number,
  ): Promise<number[] | null> {
    const now = new Date();
    const [row] = await db
      .select({
        embedding: queryEmbeddingCache.embedding,
        expiresAt: queryEmbeddingCache.expiresAt,
      })
      .from(queryEmbeddingCache)
      .where(
        and(
          eq(queryEmbeddingCache.workspaceId, workspaceId),
          eq(queryEmbeddingCache.queryHash, queryHash),
          eq(queryEmbeddingCache.embeddingModel, model),
          eq(queryEmbeddingCache.embeddingDims, dims),
        ),
      )
      .limit(1);

    if (!row) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;

    await db
      .update(queryEmbeddingCache)
      .set({
        hitCount: sql`${queryEmbeddingCache.hitCount} + 1`,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(queryEmbeddingCache.workspaceId, workspaceId),
          eq(queryEmbeddingCache.queryHash, queryHash),
          eq(queryEmbeddingCache.embeddingModel, model),
          eq(queryEmbeddingCache.embeddingDims, dims),
        ),
      )
      .catch(() => undefined);

    return row.embedding;
  }

  async setL2(
    db: Database,
    workspaceId: string,
    queryHash: string,
    model: string,
    dims: number,
    embedding: number[],
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    await db
      .insert(queryEmbeddingCache)
      .values({
        workspaceId,
        queryHash,
        embeddingModel: model,
        embeddingDims: dims,
        embedding,
        hitCount: 1,
        expiresAt,
        lastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          queryEmbeddingCache.workspaceId,
          queryEmbeddingCache.queryHash,
          queryEmbeddingCache.embeddingModel,
          queryEmbeddingCache.embeddingDims,
        ],
        set: {
          embedding,
          expiresAt,
          lastUsedAt: now,
          updatedAt: now,
          hitCount: sql`${queryEmbeddingCache.hitCount} + 1`,
        },
      });
  }

  async lookup(
    db: Database,
    input: {
      workspaceId: string;
      query: string;
      model: string;
      dimensions: number;
    },
  ): Promise<QueryEmbeddingCacheHit | null> {
    const queryHash = buildQueryEmbeddingCacheHash({
      model: input.model,
      dimensions: input.dimensions,
      query: input.query,
    });

    const l1 = this.getFromL1(input.workspaceId, queryHash, input.model, input.dimensions);
    if (l1) return { embedding: l1, layer: 'l1' };

    const l2 = await this.getFromL2(
      db,
      input.workspaceId,
      queryHash,
      input.model,
      input.dimensions,
    );
    if (l2) {
      this.setL1(input.workspaceId, queryHash, input.model, input.dimensions, l2);
      return { embedding: l2, layer: 'l2' };
    }

    return null;
  }

  async store(
    db: Database,
    input: {
      workspaceId: string;
      query: string;
      model: string;
      dimensions: number;
      embedding: number[];
    },
  ): Promise<void> {
    const queryHash = buildQueryEmbeddingCacheHash({
      model: input.model,
      dimensions: input.dimensions,
      query: input.query,
    });
    this.setL1(
      input.workspaceId,
      queryHash,
      input.model,
      input.dimensions,
      input.embedding,
    );
    await this.setL2(
      db,
      input.workspaceId,
      queryHash,
      input.model,
      input.dimensions,
      input.embedding,
    );
  }

  /**
   * Deduplicate concurrent provider calls for the same cache key.
   */
  async resolveOrLoad(
    key: string,
    loader: () => Promise<number[]>,
  ): Promise<number[]> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = loader().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  clearL1(): void {
    this.l1.clear();
  }
}

export async function purgeExpiredQueryEmbeddingCache(
  db: Database,
  now = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(queryEmbeddingCache)
    .where(lt(queryEmbeddingCache.expiresAt, now))
    .returning({ id: queryEmbeddingCache.id });
  return deleted.length;
}

let sharedCache: QueryEmbeddingCache | undefined;

export function getSharedQueryEmbeddingCache(
  options?: QueryEmbeddingCacheOptions,
): QueryEmbeddingCache {
  if (!sharedCache) {
    sharedCache = new QueryEmbeddingCache(options);
  }
  return sharedCache;
}

/** Test helper */
export function resetSharedQueryEmbeddingCache(): void {
  sharedCache = undefined;
}

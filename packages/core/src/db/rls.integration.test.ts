import { describe, it, expect } from 'vitest';
import {
  records,
  sourceRetrievalPolicies,
  sources,
  workspaces,
} from './schema/index.js';
import { withWorkspaceContext, workspaceRlsRoleExists } from './rls.js';
import { withTestDatabase } from '../test/db-helper.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';

describe.runIf(hasDatabase)('rls integration', () => {
  it('installs the gateway_app role used for RLS enforcement', async () => {
    await withTestDatabase(async (db) => {
      await expect(workspaceRlsRoleExists(db)).resolves.toBe(true);
    });
  });

  it('filters tenant rows when workspace context is set', async () => {
    await withTestDatabase(async (db) => {
      const [wsA] = await db.insert(workspaces).values({ name: 'A', slug: `rls-a-${Date.now()}`, settings: {} }).returning();
      const [wsB] = await db.insert(workspaces).values({ name: 'B', slug: `rls-b-${Date.now()}`, settings: {} }).returning();
      if (!wsA || !wsB) throw new Error('workspaces missing');

      const [sourceA] = await db
        .insert(sources)
        .values({ workspaceId: wsA.id, type: 'csv', name: 'A', config: {}, maturityStatus: 'connected' })
        .returning();
      const [sourceB] = await db
        .insert(sources)
        .values({ workspaceId: wsB.id, type: 'csv', name: 'B', config: {}, maturityStatus: 'connected' })
        .returning();
      if (!sourceA || !sourceB) throw new Error('sources missing');

      await db.insert(records).values([
        {
          workspaceId: wsA.id,
          sourceId: sourceA.id,
          entity: 'product',
          externalId: 'a-1',
          data: { sku: 'A1' },
          sourceRecordHash: 'hash-a',
          mappingVersion: 1,
          searchSource: 'a1',
        },
        {
          workspaceId: wsB.id,
          sourceId: sourceB.id,
          entity: 'product',
          externalId: 'b-1',
          data: { sku: 'B1' },
          sourceRecordHash: 'hash-b',
          mappingVersion: 1,
          searchSource: 'b1',
        },
      ]);

      const allRows = await db.select().from(records);
      expect(allRows).toHaveLength(2);

      const scopedRows = await withWorkspaceContext(db, wsA.id, (tx) => tx.select().from(records));
      expect(scopedRows).toHaveLength(1);
      expect(scopedRows[0]?.workspaceId).toBe(wsA.id);
    });
  });

  it('allows worker-style access without workspace context', async () => {
    await withTestDatabase(async (db) => {
      const [ws] = await db.insert(workspaces).values({ name: 'Worker', slug: `rls-worker-${Date.now()}`, settings: {} }).returning();
      if (!ws) throw new Error('workspace missing');

      const [source] = await db
        .insert(sources)
        .values({ workspaceId: ws.id, type: 'csv', name: 'Worker', config: {}, maturityStatus: 'connected' })
        .returning();
      if (!source) throw new Error('source missing');

      await db.insert(records).values({
        workspaceId: ws.id,
        sourceId: source.id,
        entity: 'product',
        externalId: 'w-1',
        data: { sku: 'W1' },
        sourceRecordHash: 'hash-w',
        mappingVersion: 1,
        searchSource: 'w1',
      });

      const rows = await db.select().from(records);
      expect(rows).toHaveLength(1);
    });
  });

  it('isolates retrieval policies by workspace', async () => {
    await withTestDatabase(async (db) => {
      const [wsA, wsB] = await db
        .insert(workspaces)
        .values([
          { name: 'Policy A', slug: `policy-rls-a-${Date.now()}`, settings: {} },
          { name: 'Policy B', slug: `policy-rls-b-${Date.now()}`, settings: {} },
        ])
        .returning();
      if (!wsA || !wsB) throw new Error('workspaces missing');
      const [sourceA, sourceB] = await db
        .insert(sources)
        .values([
          {
            workspaceId: wsA.id,
            type: 'csv',
            name: 'A',
            config: {},
            maturityStatus: 'agent_ready',
          },
          {
            workspaceId: wsB.id,
            type: 'csv',
            name: 'B',
            config: {},
            maturityStatus: 'agent_ready',
          },
        ])
        .returning();
      if (!sourceA || !sourceB) throw new Error('sources missing');

      await db.insert(sourceRetrievalPolicies).values([
        {
          workspaceId: wsA.id,
          sourceId: sourceA.id,
          version: 1,
          status: 'active',
          document: { entities: [] },
        },
        {
          workspaceId: wsB.id,
          sourceId: sourceB.id,
          version: 1,
          status: 'active',
          document: { entities: [] },
        },
      ]);

      const scoped = await withWorkspaceContext(db, wsA.id, (tx) =>
        tx.select().from(sourceRetrievalPolicies),
      );
      expect(scoped).toHaveLength(1);
      expect(scoped[0]?.workspaceId).toBe(wsA.id);

      await expect(
        withWorkspaceContext(db, wsA.id, (tx) =>
          tx.insert(sourceRetrievalPolicies).values({
            workspaceId: wsA.id,
            sourceId: sourceB.id,
            version: 2,
            status: 'draft',
            document: { entities: [] },
          }),
        ),
      ).rejects.toThrow();
    });
  });
});

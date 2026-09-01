import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  evalRuns,
  evalSets,
  mappings,
  recordEmbeddings,
  records,
  sourceTransitions,
  sourceRetrievalPolicies,
  sources,
  workspaces,
} from '../db/schema/index.js';
import { withTestDatabase } from '../test/db-helper.js';
import {
  activateRetrievalPolicy,
  createRetrievalPolicyDraft,
  getActiveRetrievalPoliciesForSources,
  getActiveRetrievalPolicy,
  listRetrievalPolicies,
} from './retrieval-policies.js';

const hasDatabase =
  process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';

describe.runIf(hasDatabase)('retrieval policies integration', () => {
  it('versions, validates, activates and rolls back without touching index or maturity', async () => {
    await withTestDatabase(async (db) => {
      const [workspace, otherWorkspace] = await db
        .insert(workspaces)
        .values([
          { name: 'Bayon', slug: `policy-bayon-${Date.now()}`, settings: {} },
          { name: 'Other', slug: `policy-other-${Date.now()}`, settings: {} },
        ])
        .returning();
      if (!workspace || !otherWorkspace) throw new Error('workspaces missing');

      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'shopify',
          name: 'Bayon Shopify',
          config: { shopDomain: 'bayon.myshopify.com' },
          maturityStatus: 'agent_ready',
        })
        .returning();
      if (!source) throw new Error('source missing');

      await db.insert(mappings).values({
        sourceId: source.id,
        version: 1,
        status: 'active',
        document: {
          entities: [
            {
              entity: 'variant',
              sourceTable: 'variants',
              fields: [],
              rules: [],
              embeddingTextTemplate: '{{productTitle}}',
            },
          ],
        },
      });

      const [record] = await db
        .insert(records)
        .values({
          workspaceId: workspace.id,
          sourceId: source.id,
          entity: 'variant',
          externalId: 'aida-1',
          data: { productTitle: 'Cuadrille Aida' },
          sourceRecordHash: 'hash-aida',
          mappingVersion: 1,
          searchSource: 'Cuadrille Aida',
        })
        .returning();
      if (!record) throw new Error('record missing');
      await db.insert(recordEmbeddings).values({
        recordId: record.id,
        embedding: Array.from({ length: 1024 }, () => 0),
        embeddingModel: 'mock-embedding',
        embeddingDims: 1024,
        mappingVersion: 1,
      });

      const beforeRecords = await db.select().from(records);
      const beforeEmbeddings = await db.select().from(recordEmbeddings);
      const beforeTransitions = await db.select().from(sourceTransitions);

      const v1 = await createRetrievalPolicyDraft(
        db,
        workspace.id,
        source.id,
        {
          expectedActiveVersion: 0,
          document: {
            entities: [
              {
                entity: 'variant',
                synonyms: { entries: { aida: ['cuadrille aida'] } },
                fields: [],
              },
            ],
          },
        },
      );
      expect(v1.version).toBe(1);
      expect(v1.status).toBe('draft');
      await expect(
        db
          .update(sourceRetrievalPolicies)
          .set({ document: { entities: [] } })
          .where(eq(sourceRetrievalPolicies.id, v1.id)),
      ).rejects.toThrow();
      const [immutableV1] = await db
        .select()
        .from(sourceRetrievalPolicies)
        .where(eq(sourceRetrievalPolicies.id, v1.id));
      expect(immutableV1?.document).toEqual(v1.document);

      const [evalSet] = await db
        .insert(evalSets)
        .values({
          workspaceId: workspace.id,
          sourceId: source.id,
          name: 'Bayon policy evals',
          threshold: 0.8,
        })
        .returning();
      if (!evalSet) throw new Error('eval set missing');

      await db.insert(evalRuns).values({
        evalSetId: evalSet.id,
        retrievalPolicyId: v1.id,
        status: 'completed',
        metrics: { score: 1, sensitiveLeaks: 0 },
        passed: [],
        failed: [],
        finishedAt: new Date(),
      });
      const activeV1 = await activateRetrievalPolicy(
        db,
        workspace.id,
        source.id,
        1,
        { expectedActiveVersion: 0 },
      );
      expect(activeV1.status).toBe('active');

      const v2 = await createRetrievalPolicyDraft(
        db,
        workspace.id,
        source.id,
        {
          expectedActiveVersion: 1,
          document: {
            entities: [
              {
                entity: 'variant',
                synonyms: {
                  entries: {
                    aida: ['cuadrille aida'],
                    etamina: ['caneva'],
                  },
                },
                fields: [],
              },
            ],
          },
        },
      );
      await db.insert(evalRuns).values({
        evalSetId: evalSet.id,
        retrievalPolicyId: v2.id,
        status: 'completed',
        metrics: { score: 1, sensitiveLeaks: 0 },
        passed: [],
        failed: [],
        finishedAt: new Date(),
      });
      await activateRetrievalPolicy(db, workspace.id, source.id, 2, {
        expectedActiveVersion: 1,
      });
      expect((await getActiveRetrievalPolicy(db, workspace.id, source.id))?.version).toBe(2);

      await activateRetrievalPolicy(db, workspace.id, source.id, 1, {
        expectedActiveVersion: 2,
      });
      expect((await getActiveRetrievalPolicy(db, workspace.id, source.id))?.version).toBe(1);

      const [unchangedSource] = await db.select().from(sources);
      expect(unchangedSource?.maturityStatus).toBe('agent_ready');
      expect(await db.select().from(records)).toHaveLength(beforeRecords.length);
      expect(await db.select().from(recordEmbeddings)).toHaveLength(
        beforeEmbeddings.length,
      );
      expect(await db.select().from(sourceTransitions)).toHaveLength(
        beforeTransitions.length,
      );

      await expect(
        listRetrievalPolicies(db, otherWorkspace.id, source.id),
      ).rejects.toThrow('Source not found');
    });
  });

  it('fails open when an active policy document is invalid', async () => {
    await withTestDatabase(async (db) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({
          name: 'Corrupt Policy',
          slug: `policy-corrupt-${Date.now()}`,
          settings: {},
        })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'shopify',
          name: 'Corrupt Shopify',
          config: { shopDomain: 'corrupt.myshopify.com' },
          maturityStatus: 'agent_ready',
        })
        .returning();
      if (!source) throw new Error('source missing');

      await db.insert(sourceRetrievalPolicies).values({
        workspaceId: workspace.id,
        sourceId: source.id,
        version: 1,
        status: 'active',
        document: {
          entities: [
            {
              entity: 'variant',
              synonyms: {
                entries: {
                  cuadrille: ['aida'],
                  cuadrillé: ['aida'],
                },
              },
            },
          ],
        },
      });

      const loaded = await getActiveRetrievalPoliciesForSources(db, workspace.id, [
        source.id,
      ]);
      expect(loaded.policies.size).toBe(0);
      expect(loaded.warnings[0]).toMatch(/invalid and was ignored/);
    });
  });
});

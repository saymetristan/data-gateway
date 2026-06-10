import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../db/client.js';
import { createEvalSet, seedEvalCasesFromFixture } from '../services/evals.js';
import type { CreateEvalCaseInput } from '../schemas/evals.js';

type FixtureEvalSet = {
  name: string;
  description?: string;
  threshold?: number;
  cases: CreateEvalCaseInput[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../../fixtures/shopify-evals.json');

export function loadShopifyEvalFixture(): FixtureEvalSet {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureEvalSet;
}

export async function seedShopifyEvalSet(
  db: Database,
  workspaceId: string,
  sourceId: string,
) {
  const fixture = loadShopifyEvalFixture();
  const evalSet = await createEvalSet(db, workspaceId, {
    name: fixture.name,
    description: fixture.description,
    threshold: fixture.threshold,
    sourceId,
  });
  await seedEvalCasesFromFixture(db, evalSet.id, fixture.cases);
  return evalSet;
}

import {
  createShopifyClientForSourceRecord,
  type Database,
  type ShopifyClient,
} from '@data-gateway/core';
import type { WorkerEnv } from './env.js';

export async function createShopifyClientForWorker(
  db: Database,
  sourceId: string,
  env: WorkerEnv,
): Promise<ShopifyClient> {
  return createShopifyClientForSourceRecord(
    db,
    sourceId,
    env.CREDENTIALS_ENCRYPTION_KEY,
    env.USE_MOCK_PROVIDERS,
  );
}

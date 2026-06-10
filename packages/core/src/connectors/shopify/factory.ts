import { createShopifyClient } from './client.js';
import { createMockShopifyClient } from './mock.js';
import type { ShopifyClient } from './types.js';

export function createShopifyClientForSource(
  config: {
    shopDomain: string;
    accessToken: string;
    apiVersion?: string;
  },
  useMockProviders = false,
): ShopifyClient {
  if (useMockProviders) {
    return createMockShopifyClient();
  }

  return createShopifyClient({
    shopDomain: config.shopDomain,
    accessToken: config.accessToken,
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
  });
}

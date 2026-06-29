import { createShopifyClient } from './client.js';
import { createMockShopifyClient } from './mock.js';
import type { ShopifyClient } from './types.js';

export function createShopifyClientForSource(
  config: {
    shopDomain: string;
    accessToken?: string;
    clientId?: string;
    clientSecret?: string;
    apiVersion?: string;
  },
  useMockProviders = false,
): ShopifyClient {
  if (useMockProviders) {
    return createMockShopifyClient();
  }

  return createShopifyClient({
    shopDomain: config.shopDomain,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
    ...(config.clientId ? { clientId: config.clientId } : {}),
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
  });
}

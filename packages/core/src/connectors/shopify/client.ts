import { GatewayError } from '../../errors/gateway-error.js';
import { normalizeShopifyDomain } from './domain.js';
import { parseShopifyGid } from './gid.js';
import type {
  PaginatedResult,
  ShopifyClient,
  ShopifyCollection,
  ShopifyProduct,
  ShopifyVariant,
} from './types.js';

const DEFAULT_API_VERSION = '2025-10';
const PAGE_SIZE = 5;
const MEDIA_PAGE_SIZE = 1;
const METAFIELDS_PAGE_SIZE = 20;

type GraphqlResponse<T> = {
  data?: T;
  errors?: unknown;
  extensions?: {
    cost?: {
      throttleStatus?: {
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
};

type ExistingWebhooksResponse = {
  webhookSubscriptions: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{
      node?: { uri?: string | null };
    }>;
  };
};

type ShopifyTokenProvider = () => Promise<string>;

export class ShopifyGraphqlClient implements ShopifyClient {
  private readonly endpoint: string;
  private readonly shopDomain: string;

  constructor(
    shopDomain: string,
    private readonly accessTokenProvider: ShopifyTokenProvider,
    private readonly apiVersion: string = DEFAULT_API_VERSION,
  ) {
    const domain = normalizeShopifyDomain(shopDomain);
    this.shopDomain = domain;
    this.endpoint = `https://${domain}/admin/api/${apiVersion}/graphql.json`;
  }

  async validateConnection(): Promise<{ ok: boolean; shopName?: string; message?: string }> {
    const query = `query { shop { name myshopifyDomain } }`;
    try {
      const response = await this.request<{ shop: { name: string; myshopifyDomain: string } }>(
        query,
      );
      return { ok: true, shopName: response.shop.myshopifyDomain };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Shopify connection failed';
      return { ok: false, message };
    }
  }

  async fetchProducts(options?: {
    cursor?: string;
    updatedAtMin?: string;
  }): Promise<PaginatedResult<ShopifyProduct>> {
    const query = `
      query FetchProducts($cursor: String, $query: String) {
        products(first: ${String(PAGE_SIZE)}, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              handle
              onlineStoreUrl
              productType
              status
              vendor
              tags
              updatedAt
              featuredImage { url altText }
              media(first: ${String(MEDIA_PAGE_SIZE)}) {
                edges {
                  node {
                    preview { image { url altText } }
                    ... on MediaImage { image { url altText } }
                  }
                }
              }
              metafields(first: ${String(METAFIELDS_PAGE_SIZE)}) {
                edges { node { namespace key value type } }
              }
              collections(first: 10) {
                edges { node { id title handle updatedAt } }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    title
                    price
                    compareAtPrice
                    inventoryQuantity
                    availableForSale
                    updatedAt
                    selectedOptions { name value }
                    media(first: ${String(MEDIA_PAGE_SIZE)}) {
                      edges {
                        node {
                          preview { image { url altText } }
                          ... on MediaImage { image { url altText } }
                        }
                      }
                    }
                    metafields(first: ${String(METAFIELDS_PAGE_SIZE)}) {
                      edges { node { namespace key value type } }
                    }
                    inventoryItem { id unitCost { amount } }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await this.request<{
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{ node: Record<string, unknown> }>;
      };
    }>(query, {
      cursor: options?.cursor ?? null,
      query: options?.updatedAtMin ? `updated_at:>'${options.updatedAtMin}'` : null,
    });

    const items = response.products.edges.map((edge) => this.normalizeProduct(edge.node));
    return {
      items,
      nextCursor: response.products.pageInfo.hasNextPage
        ? response.products.pageInfo.endCursor
        : null,
    };
  }

  async fetchCollections(options?: {
    cursor?: string;
  }): Promise<PaginatedResult<ShopifyCollection>> {
    const query = `
      query FetchCollections($cursor: String) {
        collections(first: ${String(PAGE_SIZE)}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node { id title handle updatedAt }
          }
        }
      }
    `;

    const response = await this.request<{
      collections: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{ node: Record<string, unknown> }>;
      };
    }>(query, { cursor: options?.cursor ?? null });

    const items = response.collections.edges.map((edge) => this.normalizeCollection(edge.node));
    return {
      items,
      nextCursor: response.collections.pageInfo.hasNextPage
        ? response.collections.pageInfo.endCursor
        : null,
    };
  }

  async fetchProductById(productId: string): Promise<ShopifyProduct | null> {
    const query = `
      query FetchProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          onlineStoreUrl
          productType
          status
          vendor
          tags
          updatedAt
          featuredImage { url altText }
          media(first: ${String(MEDIA_PAGE_SIZE)}) {
            edges {
              node {
                preview { image { url altText } }
                ... on MediaImage { image { url altText } }
              }
            }
          }
          metafields(first: ${String(METAFIELDS_PAGE_SIZE)}) {
            edges { node { namespace key value type } }
          }
          collections(first: 10) {
            edges { node { id title handle updatedAt } }
          }
          variants(first: 100) {
            edges {
              node {
                id
                sku
                title
                price
                compareAtPrice
                inventoryQuantity
                availableForSale
                updatedAt
                selectedOptions { name value }
                media(first: ${String(MEDIA_PAGE_SIZE)}) {
                  edges {
                    node {
                      preview { image { url altText } }
                      ... on MediaImage { image { url altText } }
                    }
                  }
                }
                metafields(first: ${String(METAFIELDS_PAGE_SIZE)}) {
                  edges { node { namespace key value type } }
                }
                inventoryItem { id unitCost { amount } }
              }
            }
          }
        }
      }
    `;

    const response = await this.request<{ product: Record<string, unknown> | null }>(query, {
      id: `gid://shopify/Product/${productId}`,
    });
    if (!response.product) return null;
    return this.normalizeProduct(response.product);
  }

  async fetchProductByInventoryItemId(inventoryItemId: string): Promise<ShopifyProduct | null> {
    const query = `
      query FetchProductByInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          variants(first: 1) {
            edges {
              node {
                product { id }
              }
            }
          }
        }
      }
    `;

    const response = await this.request<{
      inventoryItem: {
        variants?: { edges?: Array<{ node?: { product?: { id?: string } | null } | null }> };
      } | null;
    }>(query, {
      id: inventoryItemId.startsWith('gid://')
        ? inventoryItemId
        : `gid://shopify/InventoryItem/${inventoryItemId}`,
    });
    const productGid = response.inventoryItem?.variants?.edges?.[0]?.node?.product?.id;
    if (!productGid) return null;
    return this.fetchProductById(parseShopifyGid(productGid));
  }

  async registerWebhooks(callbackUrl: string, topics: string[]): Promise<void> {
    for (const topic of topics) {
      const graphqlTopic = toGraphqlWebhookTopic(topic);
      if (await this.webhookExists(graphqlTopic, callbackUrl)) {
        continue;
      }

      const mutation = `
        mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $uri: URL!) {
          webhookSubscriptionCreate(
            topic: $topic
            webhookSubscription: { uri: $uri, format: JSON }
          ) {
            userErrors { field message }
          }
        }
      `;
      const response = await this.request<{
        webhookSubscriptionCreate?: {
          userErrors?: Array<{ field?: string[] | string | null; message: string }>;
        };
      }>(mutation, { topic: graphqlTopic, uri: callbackUrl });
      const errors = response.webhookSubscriptionCreate?.userErrors ?? [];
      if (errors.length > 0) {
        throw GatewayError.unprocessable(
          `Shopify webhook registration failed: ${errors.map((error) => error.message).join('; ')}`,
        );
      }
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private normalizeProduct(node: Record<string, unknown>): ShopifyProduct {
    const collections = this.extractCollectionNodes(node.collections);
    const variants = this.extractVariantNodes(node.variants, parseShopifyGid(String(node.id)));
    const handle = toStringValue(node.handle);
    const onlineStoreUrl = toNullableString(node.onlineStoreUrl);
    const featuredImageUrl = extractImageUrl(node.featuredImage);
    const mediaImageUrl = extractFirstMediaImageUrl(node.media);

    return {
      id: parseShopifyGid(String(node.id)),
      title: toStringValue(node.title),
      handle,
      onlineStoreUrl,
      productUrl:
        onlineStoreUrl ?? (handle ? `https://${this.shopDomain}/products/${handle}` : null),
      productType: toStringValue(node.productType),
      featuredImageUrl,
      imageUrl: featuredImageUrl ?? mediaImageUrl,
      status: toStringValue(node.status, 'draft').toLowerCase() as ShopifyProduct['status'],
      vendor: toStringValue(node.vendor),
      tags: Array.isArray(node.tags) ? node.tags.join(', ') : toStringValue(node.tags),
      metafields: extractMetafields(node.metafields),
      updatedAt: toStringValue(node.updatedAt, new Date().toISOString()),
      collectionIds: collections.map((collection) => collection.id),
      collectionTitles: collections.map((collection) => collection.title),
      variants,
    };
  }

  private async webhookExists(topic: string, callbackUrl: string): Promise<boolean> {
    let cursor: string | null = null;
    do {
      const query = `
        query ExistingWebhooks($topics: [WebhookSubscriptionTopic!], $cursor: String) {
          webhookSubscriptions(first: 100, after: $cursor, topics: $topics) {
            pageInfo { hasNextPage endCursor }
            edges {
              node { uri }
            }
          }
        }
      `;
      const response: ExistingWebhooksResponse = await this.request(query, {
        topics: [topic],
        cursor,
      });

      if (response.webhookSubscriptions.edges.some((edge) => edge.node?.uri === callbackUrl)) {
        return true;
      }
      cursor = response.webhookSubscriptions.pageInfo.hasNextPage
        ? response.webhookSubscriptions.pageInfo.endCursor
        : null;
    } while (cursor);

    return false;
  }

  private normalizeCollection(node: Record<string, unknown>): ShopifyCollection {
    return {
      id: parseShopifyGid(String(node.id)),
      title: toStringValue(node.title),
      handle: toStringValue(node.handle),
      updatedAt: toStringValue(node.updatedAt, new Date().toISOString()),
    };
  }

  private extractCollectionNodes(value: unknown): ShopifyCollection[] {
    const edges = (value as { edges?: Array<{ node?: Record<string, unknown> }> }).edges ?? [];
    return edges
      .map((edge) => edge.node)
      .filter((node): node is Record<string, unknown> => Boolean(node))
      .map((node) => this.normalizeCollection(node));
  }

  private extractVariantNodes(value: unknown, productId: string): ShopifyVariant[] {
    const edges = (value as { edges?: Array<{ node?: Record<string, unknown> }> }).edges ?? [];
    return edges
      .map((edge) => edge.node)
      .filter((node): node is Record<string, unknown> => Boolean(node))
      .map((node) => this.normalizeVariant(node, productId));
  }

  private normalizeVariant(node: Record<string, unknown>, productId: string): ShopifyVariant {
    const options =
      (node.selectedOptions as Array<{ name: string; value: string }> | undefined) ?? [];
    const size =
      options.find((option) => option.name.toLowerCase() === 'size')?.value ??
      options.find((option) => option.name.toLowerCase() === 'talla')?.value ??
      null;
    const color = options.find((option) => option.name.toLowerCase() === 'color')?.value ?? null;
    const inventoryItem = node.inventoryItem as
      | { id?: string; unitCost?: { amount?: string } }
      | undefined;
    const unitCostRaw = inventoryItem?.unitCost?.amount;

    return {
      id: parseShopifyGid(String(node.id)),
      productId,
      inventoryItemId: inventoryItem?.id ? parseShopifyGid(inventoryItem.id) : null,
      sku: toStringValue(node.sku),
      title: toStringValue(node.title),
      price: Number(node.price ?? 0),
      compareAtPrice:
        node.compareAtPrice === null || node.compareAtPrice === undefined
          ? null
          : Number(node.compareAtPrice),
      inventoryQuantity: Number(node.inventoryQuantity ?? 0),
      availableForSale: toNullableBoolean(node.availableForSale),
      size,
      color,
      selectedOptions: options.map((option) => ({
        name: toStringValue(option.name),
        value: toStringValue(option.value),
      })),
      imageUrl: extractFirstMediaImageUrl(node.media),
      metafields: extractMetafields(node.metafields),
      unitCost: unitCostRaw ? Number(unitCostRaw) : null,
      updatedAt: toStringValue(node.updatedAt, new Date().toISOString()),
    };
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    attempt = 0,
  ): Promise<T> {
    const accessToken = await this.accessTokenProvider();
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429 && attempt < 5) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? '1');
      await sleep(retryAfter * 1000);
      return this.request<T>(query, variables, attempt + 1);
    }

    const body = (await response.json()) as GraphqlResponse<T>;
    const errors = normalizeGraphqlErrors(body.errors);
    if (!response.ok || errors.length > 0) {
      const throttled = errors.some((error) => error.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 5) {
        const restoreRate = body.extensions?.cost?.throttleStatus?.restoreRate ?? 50;
        await sleep(Math.ceil(1000 / restoreRate));
        return this.request<T>(query, variables, attempt + 1);
      }
      const message = errors.map((error) => error.message).join('; ') || response.statusText;
      throw GatewayError.unprocessable(`Shopify GraphQL error: ${message}`);
    }

    if (!body.data) {
      throw GatewayError.unprocessable('Shopify GraphQL response missing data');
    }

    return body.data;
  }
}

function toGraphqlWebhookTopic(topic: string): string {
  return topic.replace('/', '_').replace(/-/g, '_').toUpperCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toStringValue(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function toNullableString(value: unknown): string | null {
  const text = toStringValue(value).trim();
  return text ? text : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  const text = toStringValue(value).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function extractMetafields(value: unknown): Array<{
  namespace: string;
  key: string;
  value: string;
  type: string;
}> {
  const edges = (value as { edges?: Array<{ node?: Record<string, unknown> }> }).edges ?? [];
  return edges
    .map((edge) => edge.node)
    .filter((node): node is Record<string, unknown> => Boolean(node))
    .map((node) => ({
      namespace: toStringValue(node.namespace),
      key: toStringValue(node.key),
      value: toStringValue(node.value),
      type: toStringValue(node.type),
    }))
    .filter((metafield) => metafield.namespace && metafield.key);
}

function extractFirstMediaImageUrl(value: unknown): string | null {
  const edges = (value as { edges?: Array<{ node?: Record<string, unknown> }> }).edges ?? [];
  for (const edge of edges) {
    const url = extractImageUrl(edge.node);
    if (url) return url;
  }
  return null;
}

function extractImageUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  const nodeUrl = toNullableString(node.url);
  if (nodeUrl) return nodeUrl;

  const directImage = node.image as Record<string, unknown> | undefined;
  const directUrl = toNullableString(directImage?.url);
  if (directUrl) return directUrl;

  const preview = node.preview as Record<string, unknown> | undefined;
  const previewImage = preview?.image as Record<string, unknown> | undefined;
  return toNullableString(previewImage?.url);
}

function normalizeGraphqlErrors(
  value: unknown,
): Array<{ message: string; extensions?: { code?: string } }> {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];

  return values.map((item) => {
    if (typeof item === 'string') return { message: item };
    if (item && typeof item === 'object') {
      const error = item as { message?: unknown; extensions?: unknown };
      const extensions =
        error.extensions && typeof error.extensions === 'object'
          ? (error.extensions as { code?: string })
          : undefined;
      return {
        message: typeof error.message === 'string' ? error.message : JSON.stringify(item),
        ...(extensions ? { extensions } : {}),
      };
    }
    return { message: String(item) };
  });
}

export function createShopifyClient(config: {
  shopDomain: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;
}): ShopifyClient {
  const domain = normalizeShopifyDomain(config.shopDomain);
  const accessTokenProvider = config.accessToken
    ? createStaticTokenProvider(config.accessToken)
    : config.clientId && config.clientSecret
      ? createClientCredentialsTokenProvider(domain, config.clientId, config.clientSecret)
      : null;

  if (!accessTokenProvider) {
    throw GatewayError.validation(
      'Shopify source requires either accessToken or clientId/clientSecret credentials',
    );
  }

  return new ShopifyGraphqlClient(
    domain,
    accessTokenProvider,
    config.apiVersion ?? DEFAULT_API_VERSION,
  );
}

function createStaticTokenProvider(accessToken: string): ShopifyTokenProvider {
  return () => Promise.resolve(accessToken);
}

function createClientCredentialsTokenProvider(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): ShopifyTokenProvider {
  let cachedToken: { accessToken: string; expiresAt: number } | null = null;

  return async () => {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
      return cachedToken.accessToken;
    }

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    };

    if (!response.ok) {
      const message =
        typeof payload.error_description === 'string'
          ? payload.error_description
          : typeof payload.error === 'string'
            ? payload.error
            : response.statusText;
      throw GatewayError.unprocessable(`Shopify token request failed: ${message}`);
    }

    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw GatewayError.unprocessable('Shopify token response missing access_token');
    }

    const expiresInSeconds =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 24 * 60 * 60;
    cachedToken = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + Math.max(expiresInSeconds - 60, 0) * 1000,
    };

    return cachedToken.accessToken;
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShopifyClient } from './client.js';

describe('Shopify client auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges client credentials for a cached Admin API token', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/admin/oauth/access_token')) {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('grant_type=client_credentials');
        expect(String(init?.body)).toContain('client_id=client-id');
        return new Response(
          JSON.stringify({
            access_token: 'shpat_runtime_token',
            expires_in: 86399,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      expect(url).toBe('https://bayon.myshopify.com/admin/api/2025-10/graphql.json');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
        'shpat_runtime_token',
      );
      return new Response(
        JSON.stringify({
          data: {
            shop: {
              name: 'Bayon',
              myshopifyDomain: 'bayon.myshopify.com',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = createShopifyClient({
      shopDomain: 'bayon.myshopify.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    await expect(client.validateConnection()).resolves.toEqual({
      ok: true,
      shopName: 'bayon.myshopify.com',
    });
    await expect(client.validateConnection()).resolves.toEqual({
      ok: true,
      shopName: 'bayon.myshopify.com',
    });

    const tokenRequests = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/admin/oauth/access_token'),
    );
    expect(tokenRequests).toHaveLength(1);
  });

  it('handles non-array GraphQL error payloads', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/admin/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'shpat_runtime_token',
            expires_in: 86399,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          errors: {
            message: 'Access denied for collections field',
            extensions: { code: 'ACCESS_DENIED' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = createShopifyClient({
      shopDomain: 'bayon.myshopify.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    await expect(client.fetchCollections()).rejects.toThrow(
      'Shopify GraphQL error: Access denied for collections field',
    );
  });

  it('normalizes product urls, images, options and metafields from product fetches', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Product/123',
                      title: 'Lino premium',
                      handle: 'lino-premium',
                      onlineStoreUrl: null,
                      productType: 'lino',
                      status: 'ACTIVE',
                      vendor: 'Bayon',
                      tags: ['estilo:formal'],
                      updatedAt: '2026-01-01T00:00:00Z',
                      featuredImage: { url: 'https://cdn.shopify.com/product.jpg' },
                      media: { edges: [] },
                      metafields: {
                        edges: [
                          {
                            node: {
                              namespace: 'custom',
                              key: 'fabric_type',
                              value: 'lino',
                              type: 'single_line_text_field',
                            },
                          },
                        ],
                      },
                      collections: { edges: [] },
                      variants: {
                        edges: [
                          {
                            node: {
                              id: 'gid://shopify/ProductVariant/456',
                              sku: 'LIN-001',
                              title: 'Blanco / 1.50',
                              price: '199.00',
                              compareAtPrice: null,
                              inventoryQuantity: 0,
                              availableForSale: false,
                              updatedAt: '2026-01-01T00:00:00Z',
                              selectedOptions: [
                                { name: 'Color', value: 'blanco' },
                                { name: 'Ancho', value: '1.50 m' },
                              ],
                              media: {
                                edges: [
                                  {
                                    node: {
                                      preview: {
                                        image: { url: 'https://cdn.shopify.com/variant.jpg' },
                                      },
                                    },
                                  },
                                ],
                              },
                              metafields: {
                                edges: [
                                  {
                                    node: {
                                      namespace: 'custom',
                                      key: 'composition',
                                      value: '100% lino',
                                      type: 'single_line_text_field',
                                    },
                                  },
                                ],
                              },
                              inventoryItem: {
                                id: 'gid://shopify/InventoryItem/789',
                                unitCost: { amount: '80.00' },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = createShopifyClient({
      shopDomain: 'bayon.myshopify.com',
      accessToken: 'shpat_static_token',
    });

    const page = await client.fetchProducts();
    const product = page.items[0];
    const variant = product?.variants[0];

    expect(product?.productUrl).toBe('https://bayon.myshopify.com/products/lino-premium');
    expect(product?.imageUrl).toBe('https://cdn.shopify.com/product.jpg');
    expect(product?.productType).toBe('lino');
    expect(product?.metafields).toContainEqual({
      namespace: 'custom',
      key: 'fabric_type',
      value: 'lino',
      type: 'single_line_text_field',
    });
    expect(variant?.availableForSale).toBe(false);
    expect(variant?.selectedOptions).toContainEqual({ name: 'Ancho', value: '1.50 m' });
    expect(variant?.imageUrl).toBe('https://cdn.shopify.com/variant.jpg');
    expect(variant?.metafields).toContainEqual({
      namespace: 'custom',
      key: 'composition',
      value: '100% lino',
      type: 'single_line_text_field',
    });
  });
});

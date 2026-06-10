import { describe, it, expect } from 'vitest';
import { normalizeShopifyDomain } from './domain.js';
import { createMockShopifyClient } from './mock.js';
import { productToRawPayload, variantToRawPayload } from './transform.js';

describe('shopify transform', () => {
  it('normaliza payloads raw sin GIDs en sourceRecordId', async () => {
    const client = createMockShopifyClient();
    const page = await client.fetchProducts();
    const product = page.items[0];
    if (!product) throw new Error('product missing');

    const productPayload = productToRawPayload(product);
    expect(productPayload.__table).toBe('products');
    expect(productPayload.id).toBe(product.id);

    const variant = product.variants[0];
    if (!variant) throw new Error('variant missing');
    const variantPayload = variantToRawPayload(product, variant);
    expect(variantPayload.__table).toBe('variants');
    expect(variantPayload.productId).toBe(product.id);
    expect(variantPayload.inventoryItemId).toBe(variant.inventoryItemId);
    expect(variantPayload.status).toBe(product.status);
  });

  it('canoniza dominios Shopify a myshopify.com exacto', () => {
    expect(normalizeShopifyDomain('https://Demo-Shop.myshopify.com/admin')).toBe(
      'demo-shop.myshopify.com',
    );
    expect(normalizeShopifyDomain('demo-shop')).toBe('demo-shop.myshopify.com');
    expect(normalizeShopifyDomain('demo-shop.myshopify.com:8080')).toBe(
      'demo-shop.myshopify.com',
    );
  });
});

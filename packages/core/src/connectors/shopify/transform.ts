import type { ShopifyCollection, ShopifyProduct, ShopifyVariant } from './types.js';

export function productToRawPayload(product: ShopifyProduct): Record<string, unknown> {
  return {
    __table: 'products',
    id: product.id,
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    tags: product.tags,
    updatedAt: product.updatedAt,
    collectionIds: product.collectionIds,
    collectionTitles: product.collectionTitles,
  };
}

export function variantToRawPayload(
  product: ShopifyProduct,
  variant: ShopifyVariant,
): Record<string, unknown> {
  return {
    __table: 'variants',
    id: variant.id,
    productId: product.id,
    inventoryItemId: variant.inventoryItemId,
    sku: variant.sku,
    title: variant.title,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    inventoryQuantity: variant.inventoryQuantity,
    size: variant.size,
    color: variant.color,
    unitCost: variant.unitCost,
    status: product.status,
    productTitle: product.title,
    vendor: product.vendor,
    tags: product.tags,
    collections: product.collectionTitles.join(', '),
    updatedAt: variant.updatedAt,
  };
}

export function collectionToRawPayload(collection: ShopifyCollection): Record<string, unknown> {
  return {
    __table: 'collections',
    id: collection.id,
    title: collection.title,
    handle: collection.handle,
    updatedAt: collection.updatedAt,
  };
}

export function rawRecordIdsForProduct(product: ShopifyProduct): {
  productId: string;
  variantIds: string[];
} {
  return {
    productId: `products:${product.id}`,
    variantIds: product.variants.map((variant) => `variants:${variant.id}`),
  };
}

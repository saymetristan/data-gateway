import type { ShopifyCollection, ShopifyProduct, ShopifyVariant } from './types.js';

export function productToRawPayload(product: ShopifyProduct): Record<string, unknown> {
  return {
    __table: 'products',
    id: product.id,
    title: product.title,
    handle: product.handle,
    productUrl: product.productUrl,
    productType: product.productType,
    imageUrl: product.imageUrl,
    featuredImageUrl: product.featuredImageUrl,
    status: product.status,
    vendor: product.vendor,
    tags: product.tags,
    metafields: metafieldsToRecord(product.metafields),
    updatedAt: product.updatedAt,
    collectionIds: product.collectionIds,
    collectionTitles: product.collectionTitles,
  };
}

export function variantToRawPayload(
  product: ShopifyProduct,
  variant: ShopifyVariant,
): Record<string, unknown> {
  const selectedOptions = selectedOptionsToRecord(variant);
  const productMetafields = metafieldsToRecord(product.metafields);
  const variantMetafields = metafieldsToRecord(variant.metafields);
  const tagAttributes = tagsToRecord(product.tags);
  const attributes = {
    ...selectedOptions,
    ...tagAttributes,
    ...productMetafields,
    ...variantMetafields,
  };
  const width = firstAttribute(attributes, ['width', 'ancho', 'anchura']);
  const composition = firstAttribute(attributes, [
    'composition',
    'composicion',
    'composición',
    'material_composition',
    'composicion_material',
  ]);
  const fabricType =
    firstAttribute(attributes, [
      'fabric_type',
      'tipo_de_tela',
      'tipo_tela',
      'tela',
      'fabric',
      'material',
    ]) ?? nullableString(product.productType);
  const style = firstAttribute(attributes, ['style', 'estilo']);
  const available = product.status === 'active' && variant.inventoryQuantity > 0;

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
    available,
    availableForSale: variant.availableForSale,
    size: variant.size,
    color: variant.color,
    width,
    composition,
    fabricType,
    style,
    unitCost: variant.unitCost,
    status: product.status,
    productTitle: product.title,
    productHandle: product.handle,
    productUrl: product.productUrl,
    productType: product.productType,
    imageUrl: variant.imageUrl ?? product.imageUrl,
    vendor: product.vendor,
    tags: product.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    selectedOptions,
    attributes,
    productMetafields,
    variantMetafields,
    collections: product.collectionTitles,
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

function selectedOptionsToRecord(variant: ShopifyVariant): Record<string, string> {
  const result: Record<string, string> = {};
  for (const option of variant.selectedOptions) {
    const key = normalizeAttributeKey(option.name);
    if (key && option.value) result[key] = option.value;
  }
  return result;
}

function metafieldsToRecord(
  metafields: Array<{ namespace: string; key: string; value: string }>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const keyCounts = new Map<string, number>();
  for (const metafield of metafields) {
    const key = normalizeAttributeKey(metafield.key);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  for (const metafield of metafields) {
    const key = normalizeAttributeKey(metafield.key);
    const namespacedKey = normalizeAttributeKey(`${metafield.namespace}.${metafield.key}`);
    if (namespacedKey && metafield.value) result[namespacedKey] = metafield.value;
    if (key && keyCounts.get(key) === 1 && metafield.value) result[key] = metafield.value;
  }
  return result;
}

function tagsToRecord(tags: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags.split(',')) {
    const [rawKey, ...rawValue] = tag.split(/[:=]/);
    const key = normalizeAttributeKey(rawKey ?? '');
    const value = rawValue.join(':').trim();
    if (key && value) result[key] = value;
  }
  return result;
}

function firstAttribute(attributes: Record<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const key = normalizeAttributeKey(alias);
    const value = attributes[key];
    if (value) return value;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (!value) continue;
    if (aliases.some((alias) => key.endsWith(`_${normalizeAttributeKey(alias)}`))) {
      return value;
    }
  }

  return null;
}

function nullableString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeAttributeKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

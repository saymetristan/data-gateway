import type {
  PaginatedResult,
  ShopifyClient,
  ShopifyCollection,
  ShopifyProduct,
  ShopifyVariant,
} from './types.js';

const COLORS = ['rojo', 'azul', 'verde', 'negro', 'blanco', 'amarillo'] as const;
const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
const COLLECTIONS = [
  { id: '1', title: 'verano', handle: 'verano' },
  { id: '2', title: 'invierno', handle: 'invierno' },
  { id: '3', title: 'ofertas', handle: 'ofertas' },
] as const;

const PRODUCT_COUNT = 60;
const PAGE_SIZE = 25;

function buildVariant(
  productId: number,
  variantIndex: number,
  product: ShopifyProduct,
): ShopifyVariant {
  const sku = `SHOP-SKU-${String(productId).padStart(4, '0')}-${String(variantIndex + 1)}`;
  const color = COLORS[(productId + variantIndex) % COLORS.length] ?? 'rojo';
  const size = SIZES[variantIndex % SIZES.length] ?? 'M';
  const inventoryQuantity = (productId * 3 + variantIndex) % 20;
  const price = (19.99 + ((productId * 17 + variantIndex * 3) % 8000) / 100).toFixed(2);

  return {
    id: String(productId * 10 + variantIndex + 1),
    productId: String(productId),
    inventoryItemId: String(productId * 100 + variantIndex + 1),
    sku,
    title: `${product.title} - ${size}`,
    price: Number.parseFloat(price),
    compareAtPrice: null,
    inventoryQuantity,
    availableForSale: statusIsAvailable(product.status, inventoryQuantity),
    size,
    color,
    selectedOptions: [
      { name: 'Talla', value: size },
      { name: 'Color', value: color },
      { name: 'Ancho', value: variantIndex % 2 === 0 ? '1.50 m' : '1.40 m' },
    ],
    imageUrl: `https://cdn.shopify.com/mock/products/${String(productId)}-${String(variantIndex + 1)}.jpg`,
    metafields: [
      {
        namespace: 'custom',
        key: 'composition',
        value: productId % 2 === 0 ? '100% algodón' : '70% lino, 30% algodón',
        type: 'single_line_text_field',
      },
    ],
    unitCost: Number((Number(price) * 0.45).toFixed(2)),
    updatedAt: product.updatedAt,
  };
}

function buildProduct(productId: number): ShopifyProduct {
  const collection = COLLECTIONS[productId % COLLECTIONS.length] ?? COLLECTIONS[0];
  const variantCount = (productId % 4) + 1;
  const status = productId % 10 === 0 ? 'draft' : 'active';
  const updatedAt = new Date(Date.UTC(2024, 0, 1, 0, 0, productId)).toISOString();

  const product: ShopifyProduct = {
    id: String(productId),
    title: `Producto Shopify ${String(productId)}`,
    handle: `producto-shopify-${String(productId)}`,
    onlineStoreUrl: `https://mock-shop.myshopify.com/products/producto-shopify-${String(productId)}`,
    productUrl: `https://mock-shop.myshopify.com/products/producto-shopify-${String(productId)}`,
    productType: productId % 2 === 0 ? 'gabardina' : 'lino',
    featuredImageUrl: `https://cdn.shopify.com/mock/products/${String(productId)}.jpg`,
    imageUrl: `https://cdn.shopify.com/mock/products/${String(productId)}.jpg`,
    status,
    vendor: 'MockVendor',
    tags: `tag-${String(productId % 5)},categoria-${String(productId % 3)},estilo:casual`,
    metafields: [
      {
        namespace: 'custom',
        key: 'fabric_type',
        value: productId % 2 === 0 ? 'gabardina' : 'lino',
        type: 'single_line_text_field',
      },
      {
        namespace: 'custom',
        key: 'style',
        value: productId % 3 === 0 ? 'formal' : 'casual',
        type: 'single_line_text_field',
      },
    ],
    updatedAt,
    collectionIds: [collection.id],
    collectionTitles: [collection.title],
    variants: [],
  };

  for (let i = 0; i < variantCount; i++) {
    product.variants.push(buildVariant(productId, i, product));
  }

  return product;
}

function buildCatalog(): { products: ShopifyProduct[]; collections: ShopifyCollection[] } {
  const products = Array.from({ length: PRODUCT_COUNT }, (_, index) => buildProduct(index + 1));
  const collections = COLLECTIONS.map((collection) => ({
    ...collection,
    updatedAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
  }));
  return { products, collections };
}

const CATALOG = buildCatalog();

export class MockShopifyClient implements ShopifyClient {
  private products = new Map(CATALOG.products.map((product) => [product.id, product]));
  private collections = new Map(
    CATALOG.collections.map((collection) => [collection.id, collection]),
  );

  async validateConnection(): Promise<{ ok: boolean; shopName?: string; message?: string }> {
    await Promise.resolve();
    return { ok: true, shopName: 'mock-shop.myshopify.com' };
  }

  async fetchProducts(options?: {
    cursor?: string;
    updatedAtMin?: string;
  }): Promise<PaginatedResult<ShopifyProduct>> {
    await Promise.resolve();
    let items = [...this.products.values()];
    if (options?.updatedAtMin) {
      const min = new Date(options.updatedAtMin).getTime();
      items = items.filter((product) => new Date(product.updatedAt).getTime() > min);
    }

    const offset = options?.cursor ? Number(options.cursor) : 0;
    const page = items.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    return {
      items: page,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    };
  }

  async fetchCollections(options?: {
    cursor?: string;
  }): Promise<PaginatedResult<ShopifyCollection>> {
    await Promise.resolve();
    const items = [...this.collections.values()];
    const offset = options?.cursor ? Number(options.cursor) : 0;
    const page = items.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    return {
      items: page,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    };
  }

  async fetchProductById(productId: string): Promise<ShopifyProduct | null> {
    await Promise.resolve();
    return this.products.get(productId) ?? null;
  }

  async fetchProductByInventoryItemId(inventoryItemId: string): Promise<ShopifyProduct | null> {
    await Promise.resolve();
    for (const product of this.products.values()) {
      if (product.variants.some((variant) => variant.inventoryItemId === inventoryItemId)) {
        return product;
      }
    }
    return null;
  }

  async registerWebhooks(): Promise<void> {
    await Promise.resolve();
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  updateProduct(product: ShopifyProduct): void {
    this.products.set(product.id, product);
  }

  deleteProduct(productId: string): void {
    this.products.delete(productId);
  }

  getProduct(productId: string): ShopifyProduct | undefined {
    return this.products.get(productId);
  }

  listProducts(): ShopifyProduct[] {
    return [...this.products.values()];
  }
}

export function createMockShopifyClient(): MockShopifyClient {
  return new MockShopifyClient();
}

function statusIsAvailable(status: ShopifyProduct['status'], inventoryQuantity: number): boolean {
  return status === 'active' && inventoryQuantity > 0;
}

export type ShopifyCollection = {
  id: string;
  title: string;
  handle: string;
  updatedAt: string;
};

export type ShopifyMetafield = {
  namespace: string;
  key: string;
  value: string;
  type: string;
};

export type ShopifySelectedOption = {
  name: string;
  value: string;
};

export type ShopifyVariant = {
  id: string;
  productId: string;
  inventoryItemId: string | null;
  sku: string;
  title: string;
  price: number;
  compareAtPrice: number | null;
  inventoryQuantity: number;
  availableForSale: boolean | null;
  size: string | null;
  color: string | null;
  selectedOptions: ShopifySelectedOption[];
  imageUrl: string | null;
  metafields: ShopifyMetafield[];
  unitCost: number | null;
  updatedAt: string;
};

export type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  onlineStoreUrl: string | null;
  productUrl: string | null;
  productType: string;
  featuredImageUrl: string | null;
  imageUrl: string | null;
  status: 'active' | 'draft' | 'archived';
  vendor: string;
  tags: string;
  metafields: ShopifyMetafield[];
  updatedAt: string;
  collectionIds: string[];
  collectionTitles: string[];
  variants: ShopifyVariant[];
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

export interface ShopifyClient {
  validateConnection(): Promise<{ ok: boolean; shopName?: string; message?: string }>;
  fetchProducts(options?: {
    cursor?: string;
    updatedAtMin?: string;
  }): Promise<PaginatedResult<ShopifyProduct>>;
  fetchCollections(options?: { cursor?: string }): Promise<PaginatedResult<ShopifyCollection>>;
  fetchProductById(productId: string): Promise<ShopifyProduct | null>;
  fetchProductByInventoryItemId(inventoryItemId: string): Promise<ShopifyProduct | null>;
  registerWebhooks(callbackUrl: string, topics: string[]): Promise<void>;
  close(): Promise<void>;
}

export type ShopifySourceConfig = {
  shopDomain: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  apiVersion?: string;
  syncState?: {
    lastSyncedAt?: string;
  };
};

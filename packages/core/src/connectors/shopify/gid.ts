export function parseShopifyGid(gid: string): string {
  const match = /\/(\d+)$/.exec(gid);
  if (match?.[1]) return match[1];
  return gid;
}

export function toProductGid(id: string): string {
  return `gid://shopify/Product/${id}`;
}

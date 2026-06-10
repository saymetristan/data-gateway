export function normalizeShopifyDomain(value: string): string {
  const raw = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');

  if (!raw) return raw;
  if (raw.endsWith('.myshopify.com')) return raw;
  return `${raw}.myshopify.com`;
}

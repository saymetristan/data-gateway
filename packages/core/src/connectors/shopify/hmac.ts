import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeShopifyHmac(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

export function verifyShopifyHmac(
  rawBody: string,
  providedHmac: string | undefined,
  secret: string,
): boolean {
  if (!providedHmac) return false;
  const expected = computeShopifyHmac(rawBody, secret);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(providedHmac, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

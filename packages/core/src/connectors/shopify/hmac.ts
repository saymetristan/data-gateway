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
  const expectedBuffer = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const providedBuffer = Buffer.from(providedHmac, 'base64');
  const comparable =
    providedBuffer.length === expectedBuffer.length
      ? providedBuffer
      : Buffer.alloc(expectedBuffer.length);
  return timingSafeEqual(expectedBuffer, comparable) && providedBuffer.length === expectedBuffer.length;
}

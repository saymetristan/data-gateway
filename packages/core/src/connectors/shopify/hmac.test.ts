import { describe, it, expect } from 'vitest';
import { computeShopifyHmac, verifyShopifyHmac } from './hmac.js';

describe('shopify hmac', () => {
  it('valida firmas correctas', () => {
    const body = '{"id":1}';
    const secret = 'test-secret';
    const hmac = computeShopifyHmac(body, secret);
    expect(verifyShopifyHmac(body, hmac, secret)).toBe(true);
  });

  it('rechaza firmas inválidas', () => {
    expect(verifyShopifyHmac('{"id":1}', 'bad', 'secret')).toBe(false);
    expect(verifyShopifyHmac('{"id":1}', undefined, 'secret')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptValue,
  decryptValue,
  encryptSourceConfig,
  decryptSourceConfig,
  parseEncryptionKey,
} from './credentials.js';

const testKey = randomBytes(32).toString('base64');

describe('credentials crypto', () => {
  it('roundtrips encrypted values', () => {
    const key = parseEncryptionKey(testKey);
    const encrypted = encryptValue('postgresql://user:pass@host/db', key);
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(decryptValue(encrypted, key)).toBe('postgresql://user:pass@host/db');
  });

  it('rejects invalid encryption key length', () => {
    expect(() => parseEncryptionKey('short')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const key = parseEncryptionKey(testKey);
    const encrypted = encryptValue('secret', key);
    const tampered = encrypted.replace(/.$/, encrypted.endsWith('A') ? 'B' : 'A');
    expect(() => decryptValue(tampered, key)).toThrow();
  });

  it('encrypts only sensitive fields per source type', () => {
    const config = {
      connectionUrl: 'postgresql://user:pass@host/db',
      tables: ['products'],
    };
    const encrypted = encryptSourceConfig('database_url', config, testKey);
    expect(typeof encrypted.connectionUrl).toBe('string');
    expect(String(encrypted.connectionUrl).startsWith('enc:v1:')).toBe(true);
    expect(encrypted.tables).toEqual(['products']);

    const decrypted = decryptSourceConfig('database_url', encrypted, testKey);
    expect(decrypted.connectionUrl).toBe(config.connectionUrl);
  });

  it('encrypts Shopify client credentials secrets', () => {
    const encrypted = encryptSourceConfig(
      'shopify',
      {
        shopDomain: 'bayon.myshopify.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        webhookSecret: 'webhook-secret',
      },
      testKey,
    );

    expect(encrypted.clientId).toBe('client-id');
    expect(String(encrypted.clientSecret).startsWith('enc:v1:')).toBe(true);
    expect(String(encrypted.webhookSecret).startsWith('enc:v1:')).toBe(true);

    const decrypted = decryptSourceConfig('shopify', encrypted, testKey);
    expect(decrypted.clientSecret).toBe('client-secret');
    expect(decrypted.webhookSecret).toBe('webhook-secret');
  });
});

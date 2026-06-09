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
});

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export type SourceType = 'database_url' | 'csv' | 'shopify';
export type SourceConfig = Record<string, unknown>;

const SENSITIVE_FIELDS: Record<SourceType, string[]> = {
  database_url: ['connectionUrl'],
  csv: [],
  shopify: ['accessToken'],
};

export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes when base64-decoded');
  }
  return key;
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith('enc:v1:');
}

export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptValue(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid encrypted value format');
  }

  const ivPart = parts[2];
  const tagPart = parts[3];
  const encryptedPart = parts[4];
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('Invalid encrypted value format');
  }

  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  const encrypted = Buffer.from(encryptedPart, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function encryptSourceConfig(
  type: SourceType,
  config: SourceConfig,
  encryptionKey: string,
): SourceConfig {
  const key = parseEncryptionKey(encryptionKey);
  const result = { ...config };

  for (const field of SENSITIVE_FIELDS[type]) {
    const value = result[field];
    if (typeof value === 'string' && !isEncryptedValue(value)) {
      result[field] = encryptValue(value, key);
    }
  }

  return result;
}

export function decryptSourceConfig(
  type: SourceType,
  config: SourceConfig,
  encryptionKey: string,
): SourceConfig {
  const key = parseEncryptionKey(encryptionKey);
  const result = { ...config };

  for (const field of SENSITIVE_FIELDS[type]) {
    const value = result[field];
    if (typeof value === 'string' && isEncryptedValue(value)) {
      result[field] = decryptValue(value, key);
    }
  }

  return result;
}

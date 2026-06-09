import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX = 'dgw_live_';

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url');
  const key = `${API_KEY_PREFIX}${secret}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, 16),
  };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function isValidApiKeyFormat(key: string): boolean {
  return key.startsWith(API_KEY_PREFIX) && key.length > API_KEY_PREFIX.length + 16;
}

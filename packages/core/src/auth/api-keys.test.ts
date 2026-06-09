import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  isValidApiKeyFormat,
  API_KEY_PREFIX,
} from '../auth/api-keys.js';

describe('api-keys', () => {
  it('generates keys with expected prefix and verifiable hash', () => {
    const { key, hash, prefix } = generateApiKey();

    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix).toBe(key.slice(0, 16));
    expect(hash).toBe(hashApiKey(key));
    expect(isValidApiKeyFormat(key)).toBe(true);
  });

  it('rejects invalid key format', () => {
    expect(isValidApiKeyFormat('invalid')).toBe(false);
    expect(isValidApiKeyFormat(`${API_KEY_PREFIX}short`)).toBe(false);
  });
});

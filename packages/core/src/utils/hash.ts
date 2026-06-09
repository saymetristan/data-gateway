import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

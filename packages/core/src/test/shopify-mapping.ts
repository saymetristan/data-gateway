import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MappingDocument } from '../schemas/mapping.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../../fixtures/shopify-mapping.json');

export function loadShopifyMappingFixture(): MappingDocument {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as MappingDocument;
}

import { GatewayError } from '../errors/gateway-error.js';
import type { MappingDocument } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';

export function validateMappingAgainstProfile(
  document: MappingDocument,
  profile: SourceProfileDocument,
): void {
  const tables = new Map(profile.tables.map((table) => [table.table, table]));

  for (const entity of document.entities) {
    const tableProfile = tables.get(entity.sourceTable);
    if (!tableProfile) {
      throw GatewayError.validation(
        `Mapping references unknown table "${entity.sourceTable}"`,
      );
    }

    const columns = new Map(tableProfile.columns.map((column) => [column.name, column]));
    for (const field of entity.fields) {
      const column = columns.get(field.sourceColumn);
      if (!column) {
        throw GatewayError.validation(
          `Field "${field.name}" references unknown column "${field.sourceColumn}" in table "${entity.sourceTable}"`,
        );
      }
      if (!isCompatibleType(field.type, column.inferredType)) {
        throw GatewayError.validation(
          `Field "${field.name}" type "${field.type}" is incompatible with profile type "${column.inferredType}"`,
        );
      }
    }

    for (const rule of entity.rules) {
      if (!columns.has(rule.column)) {
        throw GatewayError.validation(
          `Rule for "${rule.field}" references unknown column "${rule.column}"`,
        );
      }
    }

    const fieldNames = new Set(entity.fields.map((field) => field.name));
    for (const match of entity.embeddingTextTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      const fieldName = match[1];
      if (fieldName && !fieldNames.has(fieldName)) {
        throw GatewayError.validation(
          `Embedding template references unknown field "${fieldName}" in entity "${entity.entity}"`,
        );
      }
    }

    if (entity.enrichment) {
      for (const inputField of entity.enrichment.inputFields) {
        if (!fieldNames.has(inputField)) {
          throw GatewayError.validation(
            `Enrichment input field "${inputField}" is not defined in entity "${entity.entity}"`,
          );
        }
      }
    }
  }
}

function isCompatibleType(
  mappingType: 'string' | 'number' | 'boolean' | 'date',
  profileType: string,
): boolean {
  if (mappingType === 'string') {
    return ['string', 'unknown', 'json', 'datetime'].includes(profileType);
  }
  if (mappingType === 'number') {
    return ['number', 'string', 'unknown'].includes(profileType);
  }
  if (mappingType === 'boolean') {
    return ['boolean', 'string', 'number', 'unknown'].includes(profileType);
  }
  return ['date', 'datetime', 'string', 'unknown'].includes(profileType);
}

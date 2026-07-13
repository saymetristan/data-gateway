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
      throw GatewayError.unprocessable(
        `Mapping references unknown table "${entity.sourceTable}"`,
      );
    }

    const columns = new Map(tableProfile.columns.map((column) => [column.name, column]));
    for (const field of entity.fields) {
      const column = columns.get(field.sourceColumn);
      if (!column) {
        throw GatewayError.unprocessable(
          `Field "${field.name}" references unknown column "${field.sourceColumn}" in table "${entity.sourceTable}"`,
        );
      }
      if (!isCompatibleType(field.type, column.inferredType, field.jsonPath)) {
        throw GatewayError.unprocessable(
          `Field "${field.name}" type "${field.type}" is incompatible with profile type "${column.inferredType}"`,
        );
      }
    }

    for (const rule of entity.rules) {
      if (rule.conditions?.length) {
        for (const condition of rule.conditions) {
          if (!columns.has(condition.column)) {
            throw GatewayError.unprocessable(
              `Rule for "${rule.field}" references unknown column "${condition.column}"`,
            );
          }
        }
        continue;
      }

      if (!rule.column || !columns.has(rule.column)) {
        throw GatewayError.unprocessable(
          `Rule for "${rule.field}" references unknown column "${rule.column ?? ''}"`,
        );
      }
    }

    const fieldNames = new Set(entity.fields.map((field) => field.name));
    const ruleFieldNames = new Set(entity.rules.map((rule) => rule.field));
    for (const filter of entity.defaultFilters ?? []) {
      if (!fieldNames.has(filter.field) && !ruleFieldNames.has(filter.field)) {
        throw GatewayError.unprocessable(
          `Default filter references unknown field "${filter.field}" in entity "${entity.entity}"`,
        );
      }
    }

    for (const aggregate of entity.relationAggregates ?? []) {
      if (!columns.has(aggregate.sourceColumn)) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown source column "${aggregate.sourceColumn}" in table "${entity.sourceTable}"`,
        );
      }
      const viaTable = tables.get(aggregate.viaTable);
      if (!viaTable) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown via table "${aggregate.viaTable}"`,
        );
      }
      const viaColumns = new Set(viaTable.columns.map((column) => column.name));
      if (!viaColumns.has(aggregate.viaSourceColumn)) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown via source column "${aggregate.viaSourceColumn}"`,
        );
      }
      if (!viaColumns.has(aggregate.viaTargetColumn)) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown via target column "${aggregate.viaTargetColumn}"`,
        );
      }
      const targetTable = tables.get(aggregate.targetTable);
      if (!targetTable) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown target table "${aggregate.targetTable}"`,
        );
      }
      const targetColumns = new Set(targetTable.columns.map((column) => column.name));
      if (!targetColumns.has(aggregate.targetColumn)) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown target column "${aggregate.targetColumn}"`,
        );
      }
      if (aggregate.targetLabelColumn && !targetColumns.has(aggregate.targetLabelColumn)) {
        throw GatewayError.unprocessable(
          `Relation aggregate "${aggregate.field}" references unknown target label column "${aggregate.targetLabelColumn}"`,
        );
      }
    }

    const sensitiveFieldNames = new Set(
      entity.fields.filter((field) => field.sensitive).map((field) => field.name),
    );
    for (const match of entity.embeddingTextTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      const fieldName = match[1];
      if (fieldName && !fieldNames.has(fieldName)) {
        throw GatewayError.unprocessable(
          `Embedding template references unknown field "${fieldName}" in entity "${entity.entity}"`,
        );
      }
      if (fieldName && sensitiveFieldNames.has(fieldName)) {
        throw GatewayError.unprocessable(
          `Embedding template references sensitive field "${fieldName}" in entity "${entity.entity}"`,
        );
      }
    }

    if (entity.enrichment) {
      for (const inputField of entity.enrichment.inputFields) {
        if (!fieldNames.has(inputField)) {
          throw GatewayError.unprocessable(
            `Enrichment input field "${inputField}" is not defined in entity "${entity.entity}"`,
          );
        }
      }
    }
  }
}

function isCompatibleType(
  mappingType: string,
  profileType: string,
  jsonPath?: string,
): boolean {
  if (jsonPath && profileType === 'json') {
    return ['string', 'number', 'boolean', 'date', 'json'].includes(mappingType);
  }
  if (mappingType === 'string') {
    return ['string', 'unknown', 'json', 'datetime'].includes(profileType);
  }
  if (mappingType === 'number') {
    return ['number', 'string', 'unknown'].includes(profileType);
  }
  if (mappingType === 'boolean') {
    return ['boolean', 'string', 'number', 'unknown'].includes(profileType);
  }
  if (mappingType === 'json') {
    return ['json', 'string', 'unknown'].includes(profileType);
  }
  return ['date', 'datetime', 'string', 'unknown'].includes(profileType);
}

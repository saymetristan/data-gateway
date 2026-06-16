import type { MappingEntity, MappingField } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';

export type FilterableTarget = {
  name: string;
  type: MappingField['type'];
  label: string;
  filterLabel: string;
  sourceColumn?: string | undefined;
  description?: string | undefined;
  unit?: string | undefined;
  aliases: string[];
  identifier?: boolean | undefined;
  fromRule?: boolean | undefined;
};

export function entityLabel(entity: MappingEntity): string {
  return entity.displayName ?? entity.description ?? entity.entity;
}

export function fieldLabel(field: Pick<MappingField, 'name' | 'label'>): string {
  return field.label ?? humanizeIdentifier(field.name);
}

export function filterLabel(
  field: Pick<MappingField, 'name' | 'label' | 'filterLabel'>,
): string {
  return field.filterLabel ?? field.label ?? humanizeIdentifier(field.name);
}

export function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

export function getFilterableTargets(entity: MappingEntity): FilterableTarget[] {
  const targets: FilterableTarget[] = [];
  const seen = new Set<string>();

  for (const field of entity.fields) {
    if (!field.filterable || field.sensitive) continue;
    targets.push({
      name: field.name,
      type: field.type,
      label: fieldLabel(field),
      filterLabel: filterLabel(field),
      sourceColumn: field.sourceColumn,
      ...(field.description ? { description: field.description } : {}),
      ...(field.unit ? { unit: field.unit } : {}),
      aliases: field.aliases ?? [],
      ...(field.identifier ? { identifier: true } : {}),
    });
    seen.add(field.name);
  }

  for (const rule of entity.rules) {
    if (seen.has(rule.field)) continue;
    const label = rule.label ?? humanizeIdentifier(rule.field);
    targets.push({
      name: rule.field,
      type: 'boolean',
      label,
      filterLabel: label,
      fromRule: true,
      description: rule.description ?? `Campo derivado ${label}`,
      aliases: rule.aliases ?? [],
    });
    seen.add(rule.field);
  }

  for (const filter of entity.defaultFilters) {
    if (seen.has(filter.field)) continue;
    const inferredType =
      typeof filter.value === 'boolean'
        ? 'boolean'
        : typeof filter.value === 'number'
          ? 'number'
          : 'string';
    const field = entity.fields.find((item) => item.name === filter.field);
    const label = field ? fieldLabel(field) : humanizeIdentifier(filter.field);
    targets.push({
      name: filter.field,
      type: inferredType,
      label,
      filterLabel: field ? filterLabel(field) : label,
      ...(field?.sourceColumn ? { sourceColumn: field.sourceColumn } : {}),
      fromRule: true,
      description: field?.description ?? `Campo con filtro por defecto ${label}`,
      aliases: field?.aliases ?? [],
    });
    seen.add(filter.field);
  }

  return targets;
}

export function pickIdentifierField(entity: MappingEntity): MappingField | null {
  const candidates = entity.fields.filter(
    (field) => field.filterable && !field.sensitive && field.type === 'string',
  );
  const explicit = candidates.find((field) => field.identifier);
  if (explicit) return explicit;
  const sku = candidates.find((field) => field.name.toLowerCase() === 'sku');
  if (sku) return sku;
  const id = candidates.find((field) => field.name.toLowerCase() === 'id');
  if (id) return id;
  return candidates[0] ?? null;
}

export function profileColumnsForEntity(
  entity: MappingEntity,
  profile: SourceProfileDocument,
): Map<string, ProfileColumn> {
  const table = profile.tables.find((item) => item.table === entity.sourceTable);
  const map = new Map<string, ProfileColumn>();
  if (!table) return map;
  for (const column of table.columns) {
    map.set(column.name, column);
  }
  return map;
}

export function describeTarget(target: FilterableTarget): string {
  const parts = [target.description ?? `Filtrar por ${target.filterLabel}`];
  if (target.unit) parts.push(`Unidad: ${target.unit}.`);
  if (target.aliases.length > 0) parts.push(`Alias: ${target.aliases.join(', ')}.`);
  return parts.join(' ');
}

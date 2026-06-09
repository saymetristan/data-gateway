import { z } from 'zod';
import type { MappingEntity } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import type { NormalizedFilter } from '../schemas/query.js';
import type { LlmProvider } from '../providers/llm.js';

export type LlmFallbackInput = {
  unresolvedText: string;
  entity: MappingEntity;
  profile: SourceProfileDocument;
  existingFilters: NormalizedFilter[];
  llmProvider: LlmProvider;
};

export type LlmFallbackResult = {
  filters: NormalizedFilter[];
  warnings: string[];
};

export async function extractFiltersWithLlm(
  input: LlmFallbackInput,
): Promise<LlmFallbackResult> {
  const warnings: string[] = [];
  const filterableFields = input.entity.fields.filter((field) => field.filterable);
  if (filterableFields.length === 0 || !input.unresolvedText.trim()) {
    return { filters: [], warnings };
  }

  const usedFields = new Set(input.existingFilters.map((filter) => filter.field));
  const unresolvedFields = filterableFields.filter((field) => !usedFields.has(field.name));
  if (unresolvedFields.length === 0) {
    return { filters: [], warnings };
  }

  const profileColumns = profileColumnsForEntity(input.entity, input.profile);
  const fieldDescriptions = unresolvedFields.map((field) => {
    const column = profileColumns.get(field.sourceColumn) ?? profileColumns.get(field.name);
    const enums = column?.topValues
      .slice(0, 15)
      .map((item) => String(item.value))
      .join(', ');
    return `- ${field.name} (${field.type})${enums ? `: valores comunes [${enums}]` : ''}`;
  });

  const prompt = [
    'Extrae filtros estructurados del texto del usuario.',
    'Responde SOLO con JSON válido: { "filters": { "field": value } }',
    'Usa solo estos campos filtrables:',
    ...fieldDescriptions,
    '',
    `Texto: ${input.unresolvedText}`,
  ].join('\n');

  try {
    const completion = await input.llmProvider.complete(prompt);
    const jsonText = extractJson(completion);
    const raw = JSON.parse(jsonText) as { filters?: Record<string, unknown> };
    const rawFilters = raw.filters ?? {};
    const allowedNames = new Set(unresolvedFields.map((field) => field.name));

    for (const fieldName of Object.keys(rawFilters)) {
      if (!allowedNames.has(fieldName)) {
        warnings.push(`LLM suggested unknown field "${fieldName}"; discarded`);
      }
    }

    const schema = buildFilterSchema(unresolvedFields, profileColumns);
    const parsed = schema.safeParse(rawFilters);
    if (!parsed.success) {
      warnings.push('LLM fallback returned invalid filters; ignored');
      return { filters: [], warnings };
    }

    const filters: NormalizedFilter[] = [];
    for (const [fieldName, value] of Object.entries(parsed.data)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        filters.push({ field: fieldName, op: 'eq', value });
      }
    }

    return { filters, warnings };
  } catch {
    warnings.push('LLM fallback failed; continuing with deterministic filters only');
    return { filters: [], warnings };
  }
}

function buildFilterSchema(
  fields: MappingEntity['fields'],
  profileColumns: Map<string, ProfileColumn>,
) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const column = profileColumns.get(field.sourceColumn) ?? profileColumns.get(field.name);
    switch (field.type) {
      case 'number':
        shape[field.name] = z.number().optional();
        break;
      case 'boolean':
        shape[field.name] = z.boolean().optional();
        break;
      default: {
        const allowed = new Set(
          (column?.topValues ?? [])
            .map((item) => item.value)
            .filter((value) => value !== null)
            .map((value) => String(value)),
        );
        shape[field.name] =
          allowed.size > 0
            ? z
                .string()
                .refine((value) => allowed.has(value), 'value not in profile enums')
                .optional()
            : z.string().optional();
      }
    }
  }

  return z.object(shape).partial();
}

function profileColumnsForEntity(
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

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

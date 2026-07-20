import { z } from 'zod';
import type { ToolDefinition } from '../schemas/tools.js';

export function validateToolArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const schema = buildArgsSchema(tool);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { success: false, error: parsed.error.message };
  }
  return { success: true, data: parsed.data };
}

function buildArgsSchema(tool: ToolDefinition): z.ZodType<Record<string, unknown>> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((tool.inputSchema.required as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, property] of Object.entries(properties)) {
    shape[name] = propertyToZod(property, required.has(name));
  }

  return z.object(shape).strict();
}

function propertyToZod(property: Record<string, unknown>, required: boolean): z.ZodTypeAny {
  let schema = jsonSchemaToZod(property);

  if (!required) {
    schema = schema.optional();
  }

  if (property.default !== undefined && !required) {
    schema = schema.default(property.default as never);
  }

  const description = [property.title, property.description]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(': ');
  if (description) {
    schema = schema.describe(description);
  }

  return schema;
}

function jsonSchemaToZod(property: Record<string, unknown>): z.ZodTypeAny {
  const type = property.type;

  if (type === 'array') {
    const items =
      property.items && typeof property.items === 'object' && !Array.isArray(property.items)
        ? (property.items as Record<string, unknown>)
        : { type: 'string' };
    return z.array(jsonSchemaToZod(items));
  }

  if (type === 'integer' || type === 'number') {
    let numberSchema = z.number();
    if (typeof property.minimum === 'number') {
      numberSchema = numberSchema.min(property.minimum);
    }
    if (typeof property.maximum === 'number') {
      numberSchema = numberSchema.max(property.maximum);
    }
    return type === 'integer' ? numberSchema.int() : numberSchema;
  }

  if (type === 'boolean') {
    return z.boolean();
  }

  if (Array.isArray(property.enum) && property.enum.length > 0) {
    const values = property.enum.map((value) => String(value));
    return z.enum(values as [string, ...string[]]);
  }

  return z.string();
}

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
  const type = property.type;
  let schema: z.ZodTypeAny;

  if (type === 'integer' || type === 'number') {
    let numberSchema = z.number();
    if (typeof property.minimum === 'number') {
      numberSchema = numberSchema.min(property.minimum);
    }
    if (typeof property.maximum === 'number') {
      numberSchema = numberSchema.max(property.maximum);
    }
    schema = type === 'integer' ? numberSchema.int() : numberSchema;
  } else if (type === 'boolean') {
    schema = z.boolean();
  } else if (Array.isArray(property.enum) && property.enum.length > 0) {
    const values = property.enum.map((value) => String(value));
    schema = z.enum(values as [string, ...string[]]);
  } else {
    schema = z.string();
  }

  if (!required) {
    schema = schema.optional();
  }

  if (property.default !== undefined && !required) {
    schema = schema.default(property.default as never);
  }

  return schema;
}

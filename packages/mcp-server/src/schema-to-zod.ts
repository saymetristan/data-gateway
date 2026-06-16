import { z } from 'zod';

export function jsonSchemaToZodShape(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((inputSchema.required as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, property] of Object.entries(properties)) {
    shape[name] = jsonPropertyToZod(property, required.has(name));
  }

  return shape;
}

function jsonPropertyToZod(property: Record<string, unknown>, required: boolean): z.ZodTypeAny {
  const type = property.type;
  let schema: z.ZodTypeAny;

  if (type === 'integer' || type === 'number') {
    let numberSchema = z.number();
    if (typeof property.minimum === 'number') numberSchema = numberSchema.min(property.minimum);
    if (typeof property.maximum === 'number') numberSchema = numberSchema.max(property.maximum);
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

  const description = [property.title, property.description]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(': ');
  if (description) {
    schema = schema.describe(description);
  }

  return schema;
}

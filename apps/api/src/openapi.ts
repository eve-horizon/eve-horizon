import type {
  SchemaObject,
  ReferenceObject,
  OpenAPIObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

type OpenApiSchema = SchemaObject & {
  $ref?: string;
  definitions?: Record<string, SchemaObject>;
  $schema?: string;
};

const schemaRegistry = new Map<string, SchemaObject | ReferenceObject>();

export function zodSchemaToOpenApi(schema: ZodSchema, name: string): SchemaObject | ReferenceObject {
  // Avoid deep generic instantiation from zod-to-json-schema types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonSchema = zodToJsonSchema(
    schema as any,
    {
      name,
      target: 'openApi3',
      refStrategy: 'root',
    } as any,
  ) as OpenApiSchema;

  const { $schema: _schema, definitions, ...openApiSchema } = jsonSchema;
  if (definitions) {
    for (const [key, definition] of Object.entries(definitions)) {
      schemaRegistry.set(key, definition);
    }
  }

  const refName = jsonSchema.$ref ? jsonSchema.$ref.replace('#/definitions/', '') : name;
  if (!schemaRegistry.has(refName)) {
    schemaRegistry.set(refName, openApiSchema as SchemaObject);
  }

  return { $ref: `#/components/schemas/${refName}` } as ReferenceObject;
}

export function attachRegisteredSchemas(document: OpenAPIObject): void {
  if (!document.components) {
    document.components = {};
  }
  document.components.schemas = {
    ...(document.components.schemas ?? {}),
    ...Object.fromEntries(schemaRegistry.entries()),
  };
}

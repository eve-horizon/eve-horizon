import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import YAML from 'yaml';
import { AppModule } from '../app.module';
import { attachRegisteredSchemas } from '../openapi.js';

async function exportOpenApi(): Promise<void> {
  process.env.EVE_OPENAPI_EXPORT = process.env.EVE_OPENAPI_EXPORT ?? '1';
  process.env.EVE_AUTH_ENABLED = process.env.EVE_AUTH_ENABLED ?? 'false';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://eve:eve@localhost:5432/eve';

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );

  await app.init();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Eve Horizon API')
    .setDescription('Job orchestration API')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  attachRegisteredSchemas(swaggerDocument);

  const outputDir = process.env.OPENAPI_OUT_DIR
    ? resolve(process.env.OPENAPI_OUT_DIR)
    : resolve(process.cwd(), '../../docs/system');

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'openapi.json'), JSON.stringify(swaggerDocument, null, 2));
  writeFileSync(join(outputDir, 'openapi.yaml'), YAML.stringify(swaggerDocument));

  await app.close();
}

exportOpenApi().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

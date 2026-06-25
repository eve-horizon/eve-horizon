import { Module, Global } from '@nestjs/common';
import { createDb } from '@eve/db';

@Global()
@Module({
  providers: [
    {
      provide: 'DB',
      useFactory: () => {
        if (process.env.EVE_OPENAPI_EXPORT === '1') {
          const stub = ((() => {
            throw new Error('DB access disabled during OpenAPI export');
          }) as unknown) as ReturnType<typeof createDb>;
          (stub as { end?: () => Promise<void> }).end = async () => undefined;
          return stub;
        }
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error('DATABASE_URL environment variable is required');
        }
        return createDb(databaseUrl);
      },
    },
  ],
  exports: ['DB'],
})
export class DatabaseModule {}

import { Module, Global } from '@nestjs/common';
import { createDb } from '@eve/db';

@Global()
@Module({
  providers: [
    {
      provide: 'DB',
      useFactory: () => {
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

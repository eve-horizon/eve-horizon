import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { RuntimeModule } from './runtime/runtime.module';

@Module({
  imports: [DatabaseModule, HealthModule, RuntimeModule],
})
export class AppModule {}

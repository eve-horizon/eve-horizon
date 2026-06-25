import { Module, Inject, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Db } from '@eve/db';
import { agentKvQueries } from '@eve/db';
import { OrgDocumentsController } from './org-documents.controller.js';
import { OrgDocumentsService } from './org-documents.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [OrgDocumentsController],
  providers: [OrgDocumentsService],
  exports: [OrgDocumentsService],
})
export class OrgDocumentsModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgDocumentsModule.name);
  private expiryTimer?: ReturnType<typeof setInterval>;

  constructor(@Inject('DB') private readonly db: Db) {}

  onModuleInit(): void {
    this.expiryTimer = setInterval(
      () => void this.processExpiredDocs().catch(err =>
        this.logger.error(`Doc expiry cycle failed: ${err}`),
      ),
      15 * 60 * 1000,
    );
    this.logger.log('Document expiry timer started (15m interval)');
  }

  onModuleDestroy(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.logger.log('Document expiry timer stopped');
    }
  }

  private async processExpiredDocs(): Promise<void> {
    // Phase 1: Mark newly expired docs
    const expired = await this.db<{ id: string; org_id: string; path: string }[]>`
      UPDATE org_documents
      SET lifecycle_status = 'expired', updated_at = NOW()
      WHERE expires_at IS NOT NULL
        AND expires_at <= NOW()
        AND lifecycle_status = 'active'
      RETURNING id, org_id, path
    `;

    if (expired.length > 0) {
      this.logger.log(`Marked ${expired.length} document(s) as expired`);
    }

    // Phase 2: Archive docs expired for >N days (configurable via env)
    const graceDays = parseInt(process.env.EVE_DOC_EXPIRY_GRACE_DAYS ?? '7', 10);
    const archived = await this.db<{ id: string; org_id: string; path: string }[]>`
      UPDATE org_documents
      SET lifecycle_status = 'archived',
          content = '[archived]',
          updated_at = NOW()
      WHERE lifecycle_status = 'expired'
        AND expires_at <= NOW() - INTERVAL '1 day' * ${graceDays}
      RETURNING id, org_id, path
    `;

    if (archived.length > 0) {
      this.logger.log(`Archived ${archived.length} document(s) (content preserved in version history)`);
    }

    // Phase 3: Purge expired KV entries
    try {
      const kv = agentKvQueries(this.db);
      await kv.purgeExpired(1000);
    } catch (kvErr) {
      this.logger.warn(`KV purge failed: ${kvErr}`);
    }
  }
}

import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Db } from '@eve/db';
import { orgFsIndexQueueQueries, orgDocumentQueries } from '@eve/db'; // exported by parallel agent
import { StorageService } from '../storage/storage.service.js';

const BATCH_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;
const LOCK_DURATION_MS = 30_000;
const MAX_ATTEMPTS = 5;

const INDEXABLE_MIME_TYPES = new Set([
  'text/markdown',
  'text/plain',
  'text/yaml',
  'application/yaml',
  'application/json',
  'text/x-yaml',
]);

const MAX_INDEXABLE_BYTES = 524_288; // 512 KB

/** Event types that should wake the index processor. */
const INDEXABLE_EVENT_TYPES = new Set(['file.created', 'file.updated']);

@Injectable()
export class OrgFsIndexProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgFsIndexProcessor.name);
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private unlisten: (() => Promise<void>) | undefined;

  /** True while drain() is actively claiming and processing batches. */
  private draining = false;
  /** True when a new drain was requested while one is already in flight. */
  private pendingDrain = false;

  private readonly queue: ReturnType<typeof orgFsIndexQueueQueries>;
  private readonly docs: ReturnType<typeof orgDocumentQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly storage: StorageService,
  ) {
    this.queue = orgFsIndexQueueQueries(db);
    this.docs = orgDocumentQueries(db);
  }

  async onModuleInit() {
    // Set up LISTEN/NOTIFY for near-instant wake on org_fs_events inserts.
    try {
      const subscription = await this.db.listen('org_fs_events', (payload) => {
        try {
          const data = JSON.parse(payload);
          if (INDEXABLE_EVENT_TYPES.has(data.event_type)) {
            this.logger.debug(`OrgFsIndexProcessor: wake received (event_type=${data.event_type}, path=${data.path})`);
            this.requestDrain();
          }
        } catch {
          // Malformed payload — still wake just in case.
          this.requestDrain();
        }
      });
      this.unlisten = subscription.unlisten;
      this.logger.log('OrgFsIndexProcessor: LISTEN active on channel org_fs_events');
    } catch (err) {
      this.logger.warn(`OrgFsIndexProcessor: LISTEN failed, relying on polling — ${err}`);
    }

    // Fallback poller — catches anything LISTEN might miss.
    this.intervalTimer = setInterval(() => this.requestDrain(), BATCH_INTERVAL_MS);
  }

  async onModuleDestroy() {
    clearInterval(this.intervalTimer);
    if (this.unlisten) {
      await this.unlisten().catch((err) => {
        this.logger.warn(`OrgFsIndexProcessor: unlisten error — ${err}`);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Drain coordination
  // ---------------------------------------------------------------------------

  /**
   * Single entry point for triggering a drain cycle.
   * Safe to call from NOTIFY handler, polling timer, or externally.
   * Coalesces overlapping requests so only one drain loop runs at a time.
   */
  requestDrain(): void {
    if (this.draining) {
      this.pendingDrain = true;
      return;
    }
    void this.drain();
  }

  /**
   * Loops, claiming batches from the index queue until the queue is empty.
   * Re-enters if a new drain was requested while running.
   */
  private async drain(): Promise<void> {
    this.draining = true;
    this.pendingDrain = false;
    let totalIndexed = 0;

    try {
      this.logger.debug('OrgFsIndexProcessor: drain started');

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const count = await this.processBatch();
        if (count === 0) break;
        totalIndexed += count;
      }

      this.logger.debug(`OrgFsIndexProcessor: drain complete: ${totalIndexed} item(s) indexed`);
    } finally {
      this.draining = false;

      // If someone requested a drain while we were running, go again.
      if (this.pendingDrain) {
        this.pendingDrain = false;
        void this.drain();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Batch processing (unchanged core logic)
  // ---------------------------------------------------------------------------

  /**
   * Claims and processes a single batch from the queue.
   * @returns the number of items processed (0 means queue is empty).
   */
  private async processBatch(): Promise<number> {
    if (!this.storage.isConfigured) {
      return 0;
    }

    const lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
    let items: Awaited<ReturnType<typeof this.queue.claimBatch>>;
    try {
      items = await this.queue.claimBatch(BATCH_SIZE, lockUntil);
    } catch (err) {
      this.logger.warn(`OrgFsIndexProcessor: failed to claim batch — ${err}`);
      return 0;
    }

    if (items.length === 0) {
      return 0;
    }

    this.logger.debug(`OrgFsIndexProcessor: processing ${items.length} item(s)`);

    for (const item of items) {
      try {
        await this.indexItem(item);
        await this.queue.remove(item.id);
      } catch (err) {
        this.logger.warn(
          `OrgFsIndexProcessor: failed to index ${item.path} (attempt ${item.attempts + 1}) — ${err}`,
        );
        if (item.attempts + 1 >= MAX_ATTEMPTS) {
          this.logger.warn(
            `OrgFsIndexProcessor: max attempts reached for ${item.path}, removing from queue`,
          );
          await this.queue.remove(item.id).catch((removeErr) => {
            this.logger.warn(`OrgFsIndexProcessor: failed to remove stalled item ${item.id} — ${removeErr}`);
          });
        } else {
          await this.queue.incrementAttempts(item.id).catch((incErr) => {
            this.logger.warn(`OrgFsIndexProcessor: failed to increment attempts for ${item.id} — ${incErr}`);
          });
        }
      }
    }

    return items.length;
  }

  private async indexItem(item: {
    id: string;
    org_id: string;
    path: string;
    storage_key: string;
    content_hash: string;
    mime_type: string;
  }): Promise<void> {
    // Look up org slug to construct the bucket name
    const [org] = await this.db<{ slug: string }[]>`
      SELECT slug FROM orgs WHERE id = ${item.org_id}
    `;
    if (!org) {
      throw new Error(`Org not found: ${item.org_id}`);
    }

    const bucketName = this.storage.getOrgBucketName(org.slug);
    const content = await this.storage.getObject(bucketName, item.storage_key);

    const metadata: Record<string, unknown> = {
      source: 'orgfs',
      content_hash: item.content_hash,
    };

    const existing = await this.docs.findByOrgAndPath(item.org_id, item.path);
    if (existing) {
      await this.docs.update(existing.id, {
        content,
        mime_type: item.mime_type,
        metadata,
      });
      this.logger.debug(`OrgFsIndexProcessor: updated document for ${item.path} (org ${item.org_id})`);
    } else {
      await this.docs.create({
        org_id: item.org_id,
        path: item.path,
        content,
        mime_type: item.mime_type,
        metadata,
      });
      this.logger.debug(`OrgFsIndexProcessor: created document for ${item.path} (org ${item.org_id})`);
    }
  }
}

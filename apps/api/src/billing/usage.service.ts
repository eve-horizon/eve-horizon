import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { usageRecordQueries, orgQueries } from '@eve/db';
import type { UsageRecord, UsageAggregate } from '@eve/db';

@Injectable()
export class UsageService {
  private readonly usage: ReturnType<typeof usageRecordQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.usage = usageRecordQueries(db);
    this.orgs = orgQueries(db);
  }

  async listByOrg(
    orgId: string,
    opts?: { since?: string; until?: string; limit?: number },
  ): Promise<UsageRecord[]> {
    await this.assertOrgExists(orgId);

    const since = opts?.since ? this.parseIso(opts.since, 'since') : undefined;
    const until = opts?.until ? this.parseIso(opts.until, 'until') : undefined;
    const limit = opts?.limit ? Math.max(1, Math.floor(opts.limit)) : 50;

    return this.usage.listByOrg(orgId, { since, until, limit });
  }

  async aggregateByOrg(
    orgId: string,
    opts?: { since?: string; until?: string },
  ): Promise<UsageAggregate[]> {
    await this.assertOrgExists(orgId);

    const since = opts?.since ? this.parseIso(opts.since, 'since') : undefined;
    const until = opts?.until ? this.parseIso(opts.until, 'until') : undefined;

    return this.usage.aggregateByOrg(orgId, { since, until });
  }

  private async assertOrgExists(orgId: string): Promise<void> {
    const org = await this.orgs.findById(orgId);
    if (!org) {
      throw new NotFoundException(`Org not found: ${orgId}`);
    }
  }

  private parseIso(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`${field} must be a valid ISO timestamp`);
    }
    return d;
  }
}

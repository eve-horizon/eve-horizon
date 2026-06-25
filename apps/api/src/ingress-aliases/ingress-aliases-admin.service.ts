import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { ingressAliasQueries, auditQueries } from '@eve/db';

interface ListIngressAliasesOptions {
  alias?: string;
  project_id?: string;
  environment_id?: string | null;
  limit?: number;
  offset?: number;
}

@Injectable()
export class IngressAliasesAdminService {
  private ingressAliases: ReturnType<typeof ingressAliasQueries>;
  private audits: ReturnType<typeof auditQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.ingressAliases = ingressAliasQueries(db);
    this.audits = auditQueries(db);
  }

  async list(options: ListIngressAliasesOptions) {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const rows = await this.ingressAliases.list({
      alias: options.alias,
      project_id: options.project_id,
      environment_id: options.environment_id,
      limit,
      offset,
    });

    return {
      data: rows.map((row) => ({
        id: row.id,
        alias: row.alias,
        project_id: row.project_id,
        environment_id: row.environment_id,
        service_name: row.service_name,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
      pagination: {
        limit,
        offset,
        count: rows.length,
      },
    };
  }

  async reclaim(alias: string, reason: string, actorUserId?: string | null) {
    const existing = await this.ingressAliases.findByAlias(alias);
    if (!existing) {
      throw new NotFoundException(`Ingress alias "${alias}" not found`);
    }

    await this.ingressAliases.release(existing.alias, existing.project_id);
    await this.audits.log({
      entity_type: 'ingress_alias',
      entity_id: existing.id,
      action: 'deleted',
      actor: actorUserId ?? null,
      actor_type: actorUserId ? 'user' : 'system',
      changes: {
        alias: { old: existing.alias, new: null },
        project_id: { old: existing.project_id, new: null },
        environment_id: { old: existing.environment_id, new: null },
        service_name: { old: existing.service_name, new: null },
      },
      context: {
        reason,
      },
    });

    return {
      alias: existing.alias,
      project_id: existing.project_id,
      environment_id: existing.environment_id,
      service_name: existing.service_name,
      reclaimed: true,
      reason,
    };
  }
}

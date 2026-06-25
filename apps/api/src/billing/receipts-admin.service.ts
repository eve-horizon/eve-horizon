import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  exchangeRateQueries,
  executionLogQueries,
  jobQueries,
  orgQueries,
  pricingRateCardQueries,
  projectManifestQueries,
  systemSettingsQueries,
} from '@eve/db';
import type { RateCardV1 } from '@eve/shared';
import {
  DEFAULT_BILLING_DEFAULTS_V1,
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
  DEFAULT_RESOURCE_CLASS_NAME,
  DEFAULT_RESOURCE_CLASSES_V1,
  assembleAttemptReceiptV2,
  getResourceClassSpec,
  parseBillingDefaultsV1,
  parseResourceClassesV1,
  resolveBillingConfigV1,
  resolveResourceClassName,
  type AdminRecomputeReceiptsRequest,
  type AdminRecomputeReceiptsResponse,
} from '@eve/shared';

type AttemptRow = {
  attempt_id: string;
  job_id: string;
  attempt_number: number;
  status: string;
  started_at: Date;
  execution_started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | null;
  runtime_meta: Record<string, unknown> | null;
  receipt_json: Record<string, unknown> | null;
  project_id: string;
  org_id: string;
  job_created_at: Date;
  job_ready_at: Date | null;
  job_defer_until: Date | null;
  job_phase: string;
  job_hints: Record<string, unknown> | null;
};

function parseOptionalIso(input?: string): Date | undefined {
  if (!input) return undefined;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid ISO timestamp: ${input}`);
  }
  return d;
}

function defaultSince(): Date {
  // Default to 7d back to avoid accidental full-table scans.
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

@Injectable()
export class ReceiptsAdminService {
  private readonly jobs: ReturnType<typeof jobQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;
  private readonly manifests: ReturnType<typeof projectManifestQueries>;
  private readonly logs: ReturnType<typeof executionLogQueries>;
  private readonly settings: ReturnType<typeof systemSettingsQueries>;
  private readonly rateCards: ReturnType<typeof pricingRateCardQueries>;
  private readonly fx: ReturnType<typeof exchangeRateQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.jobs = jobQueries(db);
    this.orgs = orgQueries(db);
    this.manifests = projectManifestQueries(db);
    this.logs = executionLogQueries(db);
    this.settings = systemSettingsQueries(db);
    this.rateCards = pricingRateCardQueries(db);
    this.fx = exchangeRateQueries(db);
  }

  async recompute(body: AdminRecomputeReceiptsRequest): Promise<AdminRecomputeReceiptsResponse> {
    const since = parseOptionalIso(body.since) ?? defaultSince();
    const projectId = body.project_id;
    const dryRun = body.dry_run ?? false;
    const force = body.force ?? false;

    const rows = await this.db<AttemptRow[]>`
      SELECT
        a.id AS attempt_id,
        a.job_id,
        a.attempt_number,
        a.status,
        a.started_at,
        a.execution_started_at,
        a.ended_at,
        a.duration_ms,
        a.runtime_meta,
        a.receipt_json,
        j.project_id,
        p.org_id,
        j.created_at AS job_created_at,
        j.ready_at AS job_ready_at,
        j.defer_until AS job_defer_until,
        j.phase AS job_phase,
        j.hints AS job_hints
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      JOIN projects p ON p.id = j.project_id
      WHERE a.ended_at IS NOT NULL
        AND a.ended_at >= ${since}
        AND (${projectId ?? null}::text IS NULL OR j.project_id = ${projectId ?? null}::text)
        AND (${force}::boolean OR a.receipt_json IS NULL)
      ORDER BY a.ended_at ASC
    `;

    // Resolve system billing defaults once.
    let systemDefaults = DEFAULT_BILLING_DEFAULTS_V1;
    const billingDefaultsSetting = await this.settings.get('billing.defaults');
    if (billingDefaultsSetting?.value) {
      try {
        systemDefaults = parseBillingDefaultsV1(billingDefaultsSetting.value);
      } catch (err) {
        // Keep going with defaults.
        console.warn(
          `[admin receipts] Invalid system billing.defaults; falling back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Resolve resource classes once.
    const resourceClassesSetting = await this.settings.get('resource_classes');
    const resourceClasses =
      parseResourceClassesV1(resourceClassesSetting?.value) ?? DEFAULT_RESOURCE_CLASSES_V1;

    // Cache org billing configs + FX and project manifest defaults to reduce repeated IO.
    const orgCache = new Map<string, { billing: { billing_currency: string; markup_pct: number; rate_card_name: string } }>();
    const fxCache = new Map<string, { rate: string; fetched_at: string; source: string } | null>();
    const manifestDefaultsCache = new Map<string, Record<string, unknown> | null>();

    const errors: Array<{ attempt_id: string; error: string }> = [];
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!force && row.receipt_json) {
        skipped += 1;
        continue;
      }
      if (!row.ended_at) {
        skipped += 1;
        continue;
      }

      try {
        // Org billing config
        let billing = orgCache.get(row.org_id)?.billing;
        if (!billing) {
          const org = await this.orgs.findById(row.org_id);
          billing = resolveBillingConfigV1({
            system_defaults: systemDefaults,
            org_billing_config: org?.billing_config,
          });
          orgCache.set(row.org_id, { billing });
        }

        // Rate card effective at attempt end
        const at = row.ended_at;
        const cardRow = await this.rateCards.findLatestEffective(billing.rate_card_name, at);
        const rateCard = cardRow
          ? {
              name: cardRow.name,
              version: cardRow.version,
              effective_at: cardRow.effective_at.toISOString(),
              rates: cardRow.rates_json as unknown as RateCardV1,
            }
          : {
              name: DEFAULT_RATE_CARD_NAME,
              version: DEFAULT_RATE_CARD_VERSION,
              effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
              rates: DEFAULT_RATE_CARD_V1,
            };

        const billingCurrency = (billing.billing_currency ?? 'usd').toLowerCase();
        // FX snapshot (USD -> billing currency)
        let fx = fxCache.get(billingCurrency);
        if (fx === undefined) {
          if (billingCurrency === 'usd') {
            fx = null;
          } else {
            const fxRow = await this.fx.findLatest('usd', billingCurrency);
            fx = fxRow
              ? { rate: fxRow.rate, fetched_at: fxRow.fetched_at.toISOString(), source: fxRow.source }
              : null;
          }
          fxCache.set(billingCurrency, fx);
        }

        // Manifest defaults for resource class resolution
        let manifestDefaults = manifestDefaultsCache.get(row.project_id);
        if (manifestDefaults === undefined) {
          const manifest = await this.manifests.findLatestByProject(row.project_id);
          const defaults = manifest?.parsed_defaults as Record<string, unknown> | null;
          manifestDefaults = defaults ?? null;
          manifestDefaultsCache.set(row.project_id, manifestDefaults);
        }

        const resourceClassName = resolveResourceClassName({
          job_hints: row.job_hints,
          manifest_defaults: manifestDefaults,
          fallback: DEFAULT_RESOURCE_CLASS_NAME,
        });
        const resourceSpec = getResourceClassSpec(resourceClasses, resourceClassName);

        const logs = await this.logs.listLogs(row.attempt_id);
        const { receipt, materialized } = assembleAttemptReceiptV2({
          job: {
            id: row.job_id,
            project_id: row.project_id,
            created_at: row.job_created_at,
            ready_at: row.job_ready_at,
            defer_until: row.job_defer_until,
            phase: row.job_phase,
            hints: row.job_hints,
          },
          attempt: {
            id: row.attempt_id,
            job_id: row.job_id,
            started_at: row.started_at,
            execution_started_at: row.execution_started_at,
            ended_at: row.ended_at,
            duration_ms: row.duration_ms,
            runtime_meta: row.runtime_meta,
          },
          org_id: row.org_id,
          logs: logs.map((l) => ({ type: l.type, content: l.content })),
          resource_class: {
            name: resourceClassName,
            requested_vcpu: resourceSpec?.vcpu ?? null,
            requested_memory_gib: resourceSpec?.memory_gib ?? null,
          },
          pricing: {
            rate_card: rateCard,
            markup_pct: billing.markup_pct,
            billing_currency: billingCurrency,
            fx,
          },
        });

        if (!dryRun) {
          await this.jobs.updateAttemptReceipt(row.attempt_id, receipt as unknown as Record<string, unknown>, {
            baseTotalUsd: materialized.base_total_usd,
            billedTotal: materialized.billed_total,
            billedCurrency: materialized.billed_currency,
          });
        }
        updated += 1;
      } catch (err) {
        errors.push({
          attempt_id: row.attempt_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      since: since.toISOString(),
      project_id: projectId ?? null,
      dry_run: dryRun,
      force,
      scanned_attempts: rows.length,
      updated_attempts: updated,
      skipped_attempts: skipped,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
}

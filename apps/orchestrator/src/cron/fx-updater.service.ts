import { Injectable, Inject, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { exchangeRateQueries, type Db } from '@eve/db';
import { generateExchangeRateId } from '@eve/shared';

type FxUpdaterJob = {
  key: string;
  job: CronJob;
};

/**
 * FX updater (Phase 1: Pricing Infrastructure)
 *
 * Inserts exchange rate snapshots into `exchange_rates` on a schedule.
 *
 * Disabled by default; enable with `EVE_FX_UPDATER_ENABLED=true`.
 *
 * Env vars:
 * - EVE_FX_UPDATER_ENABLED=true|false
 * - EVE_FX_SATS_SOURCE=coingecko
 * - EVE_FX_FIAT_SOURCE=ecb
 * - EVE_FX_FIAT_TARGETS=eur,gbp
 * - EVE_FX_SATS_CRON="*\\/5 * * * *" (default; every 5 minutes)
 * - EVE_FX_FIAT_CRON="0 0 * * *" (default; UTC midnight)
 */
@Injectable()
export class FxUpdaterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FxUpdaterService.name);
  private jobs: FxUpdaterJob[] = [];
  private exchangeRates: ReturnType<typeof exchangeRateQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.exchangeRates = exchangeRateQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_FX_UPDATER_ENABLED !== 'true') {
      this.logger.log('[fx] FX updater disabled (set EVE_FX_UPDATER_ENABLED=true to enable)');
      return;
    }

    const satsCron = process.env.EVE_FX_SATS_CRON ?? '*/5 * * * *';
    const fiatCron = process.env.EVE_FX_FIAT_CRON ?? '0 0 * * *';

    this.registerJob('fx:sats', satsCron, () => this.refreshSatsRate());
    this.registerJob('fx:fiat', fiatCron, () => this.refreshFiatRates());

    this.logger.log(`[fx] FX updater enabled (sats="${satsCron}", fiat="${fiatCron}")`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const { key, job } of this.jobs) {
      try {
        job.stop();
      } catch (err) {
        this.logger.warn(`[fx] Failed stopping FX job "${key}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.jobs = [];
  }

  private registerJob(key: string, cronExpr: string, fn: () => Promise<void>): void {
    if (this.jobs.some((entry) => entry.key === key)) return;

    try {
      const job = new CronJob(
        cronExpr,
        () => {
          fn().catch((err) => {
            this.logger.error(`[fx] FX job "${key}" failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        null, // onComplete
        true, // start immediately
        'UTC',
      );
      this.jobs.push({ key, job });
    } catch (err) {
      this.logger.error(`[fx] Failed to register FX job "${key}" (${cronExpr}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refreshSatsRate(): Promise<void> {
    const source = (process.env.EVE_FX_SATS_SOURCE ?? 'coingecko').toLowerCase();
    if (source !== 'coingecko') {
      this.logger.log(`[fx] sats refresh skipped: unsupported source "${source}"`);
      return;
    }

    const latest = await this.exchangeRates.findLatest('usd', 'sats');
    if (latest) {
      const ageMs = Date.now() - latest.fetched_at.getTime();
      if (ageMs < 4 * 60 * 1000) {
        // Avoid thrashing if multiple instances start at once.
        return;
      }
    }

    // Coingecko: BTC price in USD. Convert to sats-per-usd.
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`coingecko HTTP ${response.status}`);
    }
    const data = (await response.json()) as { bitcoin?: { usd?: number } };
    const btcUsd = data.bitcoin?.usd;
    if (!btcUsd || !Number.isFinite(btcUsd) || btcUsd <= 0) {
      throw new Error('coingecko: missing bitcoin.usd');
    }

    const satsPerUsd = 100_000_000 / btcUsd;

    await this.exchangeRates.create({
      id: generateExchangeRateId(),
      from_currency: 'usd',
      to_currency: 'sats',
      rate: satsPerUsd.toFixed(8), // NUMERIC; 8dp is plenty for sats-per-usd snapshots
      source: 'coingecko',
      fetched_at: new Date(),
    });
  }

  private async refreshFiatRates(): Promise<void> {
    const source = (process.env.EVE_FX_FIAT_SOURCE ?? 'ecb').toLowerCase();
    if (source !== 'ecb') {
      this.logger.log(`[fx] fiat refresh skipped: unsupported source "${source}"`);
      return;
    }

    const targets = (process.env.EVE_FX_FIAT_TARGETS ?? 'eur,gbp')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (targets.length === 0) return;

    const url = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`ecb HTTP ${response.status}`);
    }
    const xml = await response.text();

    // Extract ECB rates: 1 EUR = rate <CUR>. We only need USD + targets.
    const rates = this.parseEcbRates(xml);
    const eurUsd = rates.get('usd');
    if (!eurUsd) {
      throw new Error('ecb: missing USD rate');
    }

    // Skip if we already have a recent snapshot for all targets (approx daily).
    const now = new Date();
    const minAgeMs = 20 * 60 * 60 * 1000;
    let allFresh = true;
    for (const target of targets) {
      const latest = await this.exchangeRates.findLatest('usd', target);
      if (!latest) {
        allFresh = false;
        break;
      }
      const ageMs = now.getTime() - latest.fetched_at.getTime();
      if (ageMs >= minAgeMs) {
        allFresh = false;
        break;
      }
    }
    if (allFresh) return;

    for (const target of targets) {
      if (target === 'usd') continue;
      const eurTarget = target === 'eur' ? 1 : rates.get(target);
      if (!eurTarget) {
        this.logger.warn(`[fx] ecb: missing rate for "${target}"`);
        continue;
      }

      // 1 USD = (EUR->TARGET) / (EUR->USD) TARGET
      const usdToTarget = eurTarget / eurUsd;
      await this.exchangeRates.create({
        id: generateExchangeRateId(),
        from_currency: 'usd',
        to_currency: target,
        rate: usdToTarget.toFixed(10),
        source: 'ecb',
        fetched_at: now,
      });
    }
  }

  private parseEcbRates(xml: string): Map<string, number> {
    const out = new Map<string, number>();
    const re = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(xml)) !== null) {
      const currency = match[1]?.toLowerCase();
      const rate = Number(match[2]);
      if (!currency) continue;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      out.set(currency, rate);
    }
    return out;
  }
}

import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { systemSettingsQueries, environmentHealthQueries } from '@eve/db';
import { loadConfig } from '@eve/shared';

/** Structured alert from the orchestrator's env-health watchdog. */
export interface PlatformAlert {
  severity: 'info' | 'warning' | 'critical';
  type: string; // e.g. env.health.degraded, env.health.recovered
  environment?: {
    org_slug: string;
    project_slug: string;
    env_name: string;
    environment_id?: string;
  };
  issues?: Array<{
    type: string;
    pod: string;
    container?: string;
    restarts?: number;
    reason?: string;
    age?: string;
    image?: string;
  }>;
  actions_taken?: Array<{
    type: string;
    deployment: string;
    at?: string;
  }>;
  message?: string; // Free-form text for generic alerts (e.g. sentinel.startup)
}

/** Dedup window: suppress re-notification for the same environment within 4 hours. */
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000;

@Injectable()
export class PlatformNotifyService {
  private readonly logger = new Logger(PlatformNotifyService.name);
  private readonly settings;
  private readonly healthChecks;

  constructor(@Inject('DB') private readonly db: Db) {
    this.settings = systemSettingsQueries(db);
    this.healthChecks = environmentHealthQueries(db);
  }

  /**
   * Process a structured alert and deliver it to the configured Slack channel
   * via the gateway, respecting dedup rules and sentinel configuration.
   */
  async notify(alert: PlatformAlert): Promise<{ delivered: boolean; reason?: string }> {
    // 1. Check if sentinel is enabled
    const enabledSetting = await this.settings.get('sentinel.enabled');
    if (enabledSetting?.value !== 'true') {
      return { delivered: false, reason: 'sentinel disabled' };
    }

    // 2. Check dedup — skip if same environment was notified recently
    //    Recovery and circuit-breaker notifications always bypass dedup.
    const alwaysSendTypes = ['env.health.recovered', 'env.health.circuit_broken', 'sentinel.startup', 'sentinel.report'];
    if (!alwaysSendTypes.includes(alert.type) && alert.environment?.environment_id) {
      const existing = await this.healthChecks.findByEnvironmentId(alert.environment.environment_id);
      if (existing?.notified_at) {
        const elapsed = Date.now() - new Date(existing.notified_at).getTime();
        if (elapsed < DEDUP_WINDOW_MS && existing.issue_signature === this.buildIssueSignature(alert)) {
          return { delivered: false, reason: 'dedup: notified within 4h for same issues' };
        }
      }
    }

    // 3. Resolve Slack delivery config from system settings
    const integrationId = (await this.settings.get('sentinel.slack.integration_id'))?.value;
    const channelId = (await this.settings.get('sentinel.slack.channel_id'))?.value;

    if (!integrationId || !channelId) {
      this.logger.warn('Sentinel Slack config incomplete — missing integration_id or channel_id');
      return { delivered: false, reason: 'slack config incomplete' };
    }

    // Look up the integration to get the Slack team_id (account_id)
    const [integration] = await this.db<Array<{ account_id: string }>>`
      SELECT account_id FROM integrations WHERE id = ${integrationId} AND provider = 'slack' LIMIT 1
    `;
    if (!integration) {
      this.logger.warn(`Sentinel Slack integration ${integrationId} not found`);
      return { delivered: false, reason: 'slack integration not found' };
    }

    // 4. Format the message
    const text = this.formatMessage(alert);

    // 5. Deliver via gateway
    const config = loadConfig();
    const gatewayUrl = config.EVE_GATEWAY_URL ?? process.env.EVE_GATEWAY_URL;
    if (!gatewayUrl) {
      this.logger.warn('EVE_GATEWAY_URL not configured — cannot deliver sentinel notification');
      return { delivered: false, reason: 'gateway url not configured' };
    }

    try {
      const response = await fetch(`${gatewayUrl}/internal/deliver`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-internal-token': config.EVE_INTERNAL_API_KEY ?? '',
        },
        body: JSON.stringify({
          provider: 'slack',
          account_id: integration.account_id,
          channel_id: channelId,
          text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        this.logger.error(`Gateway delivery failed (${response.status}): ${body}`);
        return { delivered: false, reason: `gateway error: ${response.status}` };
      }

      // 6. Mark as notified (dedup tracking)
      if (alert.environment?.environment_id) {
        await this.healthChecks.markNotified(alert.environment.environment_id);
      }

      this.logger.log(`Sentinel notification delivered: ${alert.type} ${alert.environment?.env_name ?? ''}`);
      return { delivered: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to deliver sentinel notification: ${message}`);
      return { delivered: false, reason: `delivery error: ${message}` };
    }
  }

  /**
   * Return sentinel Slack config for gateway channel routing.
   */
  async getSentinelConfig(): Promise<{ channel_id: string | null }> {
    const channelId = (await this.settings.get('sentinel.slack.channel_id'))?.value ?? null;
    return { channel_id: channelId };
  }

  /**
   * Build a stable signature from the alert's issues for dedup comparison.
   */
  private buildIssueSignature(alert: PlatformAlert): string {
    if (!alert.issues?.length) return '';
    const types = alert.issues.map((i) => i.type).sort();
    return types.join(',');
  }

  /**
   * Format a structured alert as markdown.
   * The gateway converts markdown to Slack Block Kit.
   */
  private formatMessage(alert: PlatformAlert): string {
    const envPath = alert.environment
      ? `${alert.environment.org_slug} / ${alert.environment.project_slug} / ${alert.environment.env_name}`
      : '';

    switch (alert.type) {
      case 'env.health.degraded': {
        const issueLines = (alert.issues ?? []).map((i) => {
          const restartInfo = i.restarts ? ` (${i.restarts} restarts)` : '';
          return `- ${i.type}: ${i.pod}${restartInfo}`;
        });
        return [
          `\u26a0\ufe0f **Environment Degraded** \u2014 ${envPath}`,
          '',
          ...issueLines,
          '',
          '**Recovery:**',
          `- \`eve env diagnose <project> ${alert.environment?.env_name ?? '<env>'}\``,
        ].join('\n');
      }

      case 'env.health.critical': {
        const issueLines = (alert.issues ?? []).map((i) => {
          const restartInfo = i.restarts ? ` (${i.restarts} restarts)` : '';
          const imageInfo = i.image ? `\n  Image: ${i.image}` : '';
          return `- ${i.type}: ${i.pod}${restartInfo}${imageInfo}`;
        });
        return [
          `\ud83d\udd34 **Environment Critical** \u2014 ${envPath}`,
          '',
          ...issueLines,
          '',
          '**Recovery:**',
          `- \`eve env diagnose <project> ${alert.environment?.env_name ?? '<env>'}\``,
          `- \`eve env deploy <project> ${alert.environment?.env_name ?? '<env>'} --tag <working-tag>\``,
        ].join('\n');
      }

      case 'env.health.circuit_broken': {
        const actionLines = (alert.actions_taken ?? []).map(
          (a) => `- Scaled \`${a.deployment}\` to 0 replicas`,
        );
        return [
          `\u26a1 **Circuit-Breaker Activated** \u2014 ${envPath}`,
          '',
          ...actionLines,
          '',
          'Terminal failure pods have been scaled to zero to stop retry storms.',
          '',
          '**Recovery:**',
          `- \`eve env diagnose <project> ${alert.environment?.env_name ?? '<env>'}\``,
          `- \`eve env deploy <project> ${alert.environment?.env_name ?? '<env>'} --tag <working-tag>\``,
        ].join('\n');
      }

      case 'env.health.recovered':
        return [
          `\u2705 **Environment Recovered** \u2014 ${envPath}`,
          '',
          'All pods are healthy.',
        ].join('\n');

      default:
        // Generic message (sentinel.startup, sentinel.report, etc.)
        return alert.message ?? `Platform notification: ${alert.type}`;
    }
  }
}

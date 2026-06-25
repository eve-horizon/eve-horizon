import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { environmentHealthQueries } from '@eve/db';
import type { HealthStatus, HealthIssue, HealthAction, EnvironmentHealthCheck } from '@eve/db';

/** Parse JSONB fields that may come back as strings from postgres */
function parseJsonField<T>(val: T | string | null | undefined): T | null {
  if (val == null) return null;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return val as T;
}

@Injectable()
export class PlatformResponderService {
  private readonly logger = new Logger(PlatformResponderService.name);
  private readonly healthChecks;

  constructor(@Inject('DB') private readonly db: Db) {
    this.healthChecks = environmentHealthQueries(db);
  }

  /**
   * Handle an inbound message from the sentinel Slack channel.
   * Returns a markdown response string.
   */
  async respond(text: string): Promise<string> {
    const normalized = text.trim().toLowerCase();

    // Strip leading bot mention: Slack sends <@U12345>, plain text has @evebot
    const cleaned = normalized.replace(/^<@[^>]+>\s*/i, '').replace(/^@?\s*evebot\s*/i, '').trim();

    if (this.matches(cleaned, ['health', 'status'])) {
      return this.buildHealthReport();
    }

    if (this.matches(cleaned, ['degraded', 'issues'])) {
      return this.buildDegradedReport();
    }

    if (this.matches(cleaned, ['resources', 'report'])) {
      // For now, same as health report — resource metrics come later
      return this.buildHealthReport();
    }

    if (this.matches(cleaned, ['help', 'cmds', 'commands'])) {
      return this.buildHelpText();
    }

    return 'I can help with: **health**, **degraded**, **resources**, **help**';
  }

  private matches(text: string, keywords: string[]): boolean {
    // Strip trailing punctuation (e.g. "status?" → "status")
    const clean = text.replace(/[?!.,]+$/, '');
    return keywords.some((kw) => clean === kw || clean.startsWith(kw + ' '));
  }

  private async buildHealthReport(): Promise<string> {
    const summary = await this.healthChecks.summary();
    const environments = await this.healthChecks.listAll({ limit: 50 });

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const lines: string[] = [
      `**Platform Health Report** \u2014 ${now}`,
      '',
      `Environments: ${summary.total} tracked`,
      `  \u2705 ${summary.healthy} healthy`,
      `  \ud83d\udfe1 ${summary.degraded} degraded`,
      `  \ud83d\udd34 ${summary.critical} critical`,
    ];

    // Show non-healthy environments
    const unhealthy = environments.filter((e) => e.status !== 'healthy');
    if (unhealthy.length > 0) {
      lines.push('', '**Issues:**');
      for (const env of unhealthy) {
        const icon = env.status === 'critical' ? '\ud83d\udd34' : '\ud83d\udfe1';
        lines.push(`${icon} **${env.environment_slug}** \u2014 ${env.status}`);
        const issues = parseJsonField<HealthIssue[]>(env.issues_json);
        if (issues) {
          for (const issue of issues) {
            const restartInfo = issue.restarts ? ` (${issue.restarts} restarts)` : '';
            lines.push(`  - ${issue.type}: ${issue.pod}${restartInfo}`);
          }
        }
      }
    }

    if (summary.total === 0) {
      lines.push('', 'No environments are being monitored yet.');
    }

    return lines.join('\n');
  }

  private async buildDegradedReport(): Promise<string> {
    const degraded = await this.healthChecks.listAll({ status: 'degraded' as HealthStatus, limit: 50 });
    const critical = await this.healthChecks.listAll({ status: 'critical' as HealthStatus, limit: 50 });
    const all = [...critical, ...degraded];

    if (all.length === 0) {
      return '\u2705 No degraded or critical environments. All clear.';
    }

    const lines: string[] = [`**Degraded & Critical Environments** (${all.length})`, ''];

    for (const env of all) {
      const icon = env.status === 'critical' ? '\ud83d\udd34' : '\ud83d\udfe1';
      lines.push(`${icon} **${env.environment_slug}** \u2014 ${env.status}`);
      const issues2 = parseJsonField<HealthIssue[]>(env.issues_json);
      if (issues2) {
        for (const issue of issues2) {
          const restartInfo = issue.restarts ? ` (${issue.restarts} restarts)` : '';
          lines.push(`  - ${issue.type}: ${issue.pod}${restartInfo}`);
        }
      }
      const actions = parseJsonField<HealthAction[]>(env.actions_taken_json);
      if (actions?.length) {
        for (const action of actions) {
          lines.push(`  - Action: ${action.type} on ${action.deployment}`);
        }
      }
    }

    return lines.join('\n');
  }

  private buildHelpText(): string {
    return [
      '**Platform Sentinel Commands**',
      '',
      '- **health** or **status** \u2014 Full environment health report',
      '- **degraded** or **issues** \u2014 Show only unhealthy environments',
      '- **resources** or **report** \u2014 Resource usage report',
      '- **help** or **cmds** \u2014 This help text',
    ].join('\n');
  }
}

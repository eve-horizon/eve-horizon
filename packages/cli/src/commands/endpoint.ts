import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

export async function handleEndpoint(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;

  if (!orgId) {
    throw new Error('Missing --org flag or profile default org.');
  }

  const basePath = `/orgs/${orgId}/endpoints`;

  switch (subcommand) {
    case 'add': {
      const name = getStringFlag(flags, ['name']) ?? positionals[0];
      const hostname = getStringFlag(flags, ['tailscale-hostname', 'hostname']);
      const portStr = getStringFlag(flags, ['port']);
      const healthPath = getStringFlag(flags, ['health-path']);

      if (!name || !hostname || !portStr) {
        throw new Error(
          'Usage: eve endpoint add --name <name> --tailscale-hostname <fqdn> --port <port> --org <org_id> [--health-path <path>]',
        );
      }

      const port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('--port must be a valid port number (1-65535)');
      }

      const body: Record<string, unknown> = {
        name,
        provider: 'tailscale',
        hostname,
        port,
      };
      if (healthPath !== undefined) {
        body.health_path = healthPath === 'none' ? null : healthPath;
      }

      const response = await requestJson<Record<string, unknown>>(context, basePath, {
        method: 'POST',
        body,
      });

      if (json) {
        outputJson(response, true);
      } else {
        const clusterUrl = response.cluster_url ?? 'unknown';
        const status = response.status ?? 'unknown';
        console.log(`✓ Endpoint registered: ${name}`);
        console.log(`  Status:      ${status}`);
        console.log(`  Cluster URL: ${clusterUrl}`);
        console.log(`  K8s Service: ${response.k8s_svc_name}.${response.k8s_namespace}`);
        if (status === 'error' && response.status_msg) {
          console.log(`  Error:       ${response.status_msg}`);
        }
        console.log('');
        console.log(`Use this URL in your secrets:`);
        console.log(`  eve secrets set LLM_BASE_URL "${clusterUrl}/v1" --scope org --org ${orgId}`);
      }
      return;
    }

    case 'list': {
      const response = await requestJson(context, basePath);
      if (json) {
        outputJson(response, true);
      } else {
        const data = (response as { data?: Array<Record<string, unknown>> }).data ?? [];
        if (data.length === 0) {
          console.log('No private endpoints registered.');
        } else {
          console.log(`Private endpoints for org ${orgId}:\n`);
          for (const ep of data) {
            const status = ep.status === 'ready' ? '✓' : ep.status === 'error' ? '✗' : '…';
            console.log(`  ${status} ${ep.name}  (${ep.hostname}:${ep.port})  [${ep.status}]`);
            console.log(`    URL: ${ep.cluster_url ?? 'pending'}`);
          }
        }
      }
      return;
    }

    case 'show': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Usage: eve endpoint show <name> --org <org_id>');
      }
      const verbose = Boolean(flags.verbose);
      const response = await requestJson<Record<string, unknown>>(context, `${basePath}/${name}`);

      if (json) {
        outputJson(response, true);
      } else {
        console.log(`Name:        ${response.name}`);
        console.log(`Org:         ${orgId}`);
        console.log(`Provider:    ${response.provider}`);
        console.log(`Hostname:    ${response.hostname}`);
        console.log(`Port:        ${response.port}`);
        console.log(`Status:      ${response.status}`);
        console.log(`Cluster DNS: ${response.k8s_dns}:${response.port}`);
        console.log(`Cluster URL: ${response.cluster_url}`);
        if (response.status_msg) {
          console.log(`Status Msg:  ${response.status_msg}`);
        }

        if (verbose && response.health_path) {
          console.log('');
          console.log('Running health check...');
          try {
            const health = await requestJson<{ health: Record<string, unknown> }>(
              context,
              `${basePath}/${name}/health`,
            );
            const h = health.health;
            console.log(`  Last checked: ${h.checked_at}`);
            if (h.reachable) {
              console.log(`  HTTP GET ${response.health_path} → ${h.http_status} OK (${h.response_time_ms}ms)`);
            } else {
              console.log(`  Unreachable: ${h.error}`);
            }
          } catch (err) {
            console.log(`  Health check failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      return;
    }

    case 'remove': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Usage: eve endpoint remove <name> --org <org_id>');
      }
      await requestJson(context, `${basePath}/${name}`, { method: 'DELETE' });
      outputJson({ ok: true }, json, `✓ Endpoint '${name}' removed`);
      return;
    }

    case 'health': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Usage: eve endpoint health <name> --org <org_id>');
      }
      const response = await requestJson(context, `${basePath}/${name}/health`);
      outputJson(response, json);
      return;
    }

    case 'diagnose': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Usage: eve endpoint diagnose <name> --org <org_id>');
      }
      const response = await requestJson<{ checks: Array<{ name: string; passed: boolean; detail: string | null }> }>(
        context,
        `${basePath}/${name}/diagnose`,
      );

      if (json) {
        outputJson(response, true);
      } else {
        console.log(`Diagnostics for endpoint '${name}':\n`);
        for (const check of response.checks) {
          const icon = check.passed ? '✓' : '✗';
          const detail = check.detail ? ` — ${check.detail}` : '';
          console.log(`  ${icon} ${check.name}${detail}`);
        }
      }
      return;
    }

    default:
      throw new Error(
        'Usage: eve endpoint <add|list|show|remove|health|diagnose>\n\n' +
        '  add       Register a private endpoint backed by Tailscale\n' +
        '  list      List endpoints for an org\n' +
        '  show      Show endpoint details\n' +
        '  remove    Remove an endpoint\n' +
        '  health    Run a health check\n' +
        '  diagnose  Run diagnostics on an endpoint',
      );
  }
}

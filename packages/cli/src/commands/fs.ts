import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { hostname } from 'node:os';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import type {
  OrgFsCreateLinkResponse,
  OrgFsCreateShareRequest,
  OrgFsCreatePublicPathRequest,
  OrgFsEnrollDeviceResponse,
  OrgFsEventListResponse,
  OrgFsListConflictsResponse,
  OrgFsListLinksResponse,
  OrgFsPublicPathListResponse,
  OrgFsShare,
  OrgFsShareListResponse,
  OrgFsStatusResponse,
} from '@eve/shared';

function getOrgOrThrow(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): string {
  const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
  if (!orgId) {
    throw new Error('Missing org id. Provide --org or set a profile default.');
  }
  return orgId;
}

function parseModeFlag(value: string | undefined): 'two_way' | 'push_only' | 'pull_only' {
  const raw = (value ?? 'two-way').trim().toLowerCase();
  if (raw === 'two-way' || raw === 'two_way') return 'two_way';
  if (raw === 'push-only' || raw === 'push_only') return 'push_only';
  if (raw === 'pull-only' || raw === 'pull_only') return 'pull_only';
  throw new Error(`Invalid mode: ${value}. Use two-way, push-only, or pull-only.`);
}

function parseStrategyFlag(value: string | undefined): 'pick_local' | 'pick_remote' | 'manual' {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'pick-local' || raw === 'pick_local') return 'pick_local';
  if (raw === 'pick-remote' || raw === 'pick_remote') return 'pick_remote';
  if (raw === 'manual') return 'manual';
  throw new Error(`Invalid strategy: ${value}. Use pick-local, pick-remote, or manual.`);
}

function parseGlobList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function resolveLinkId(
  context: ResolvedContext,
  orgId: string,
  flags: Record<string, FlagValue>,
): Promise<string> {
  const explicit = getStringFlag(flags, ['link', 'link-id', 'link_id']);
  const links = await requestJson<OrgFsListLinksResponse>(context, `/orgs/${orgId}/fs/links`);
  if (explicit) {
    const found = links.data.find((item) => item.id === explicit);
    if (!found) {
      throw new Error(`Link not found: ${explicit}`);
    }
    return found.id;
  }
  if (links.data.length === 0) {
    throw new Error('No sync links found. Run: eve fs sync init --org <org> --local <path>');
  }
  return links.data[0].id;
}

async function streamFsEvents(
  context: ResolvedContext,
  orgId: string,
  afterSeq: number,
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  const response = await fetch(`${context.apiUrl}/orgs/${orgId}/fs/events/stream?after_seq=${afterSeq}`, {
    method: 'GET',
    headers,
  });
  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const eventBlock of events) {
      const lines = eventBlock.split('\n');
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData += `${line.slice(5).trim()}\n`;
        }
      }

      if (currentData) {
        const payload = currentData.trim();
        if (currentEvent === 'fs_event') {
          try {
            const parsed = JSON.parse(payload) as {
              seq: number;
              event_type: string;
              path: string;
              source_side: string;
              created_at: string;
            };
            console.log(`[${parsed.seq}] ${parsed.event_type} ${parsed.path} (${parsed.source_side}) ${parsed.created_at}`);
          } catch {
            console.log(payload);
          }
        } else if (currentEvent === 'error') {
          console.error(payload);
        }
      }

      currentEvent = '';
      currentData = '';
    }
  }
}

async function handleSync(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getOrgOrThrow(flags, context);

  switch (action) {
    case 'init': {
      const localPath = getStringFlag(flags, ['local', 'path']);
      if (!localPath) {
        throw new Error('Usage: eve fs sync init --org <org_id> --local <path> [--mode two-way]');
      }

      const mode = parseModeFlag(getStringFlag(flags, ['mode']));
      const includes = parseGlobList(getStringFlag(flags, ['include', 'includes']));
      const excludes = parseGlobList(getStringFlag(flags, ['exclude', 'excludes']));
      const publicKey = getStringFlag(flags, ['public-key', 'public_key']);

      const enroll = await requestJson<OrgFsEnrollDeviceResponse>(context, `/orgs/${orgId}/fs/devices/enroll`, {
        method: 'POST',
        body: {
          device_name: getStringFlag(flags, ['device-name', 'device_name']) ?? hostname(),
          platform: process.platform,
          client_version: 'dev',
          ...(publicKey ? { public_key: publicKey } : {}),
        },
      });

      const link = await requestJson<OrgFsCreateLinkResponse>(context, `/orgs/${orgId}/fs/links`, {
        method: 'POST',
        body: {
          device_id: enroll.device.id,
          mode,
          local_path: localPath,
          remote_path: getStringFlag(flags, ['remote-path', 'remote_path']) ?? '/',
          ...(includes ? { includes } : {}),
          ...(excludes ? { excludes } : {}),
        },
      });

      outputJson({
        device: enroll.device,
        enrollment: enroll.enrollment,
        link: link.link,
        runtime: link.runtime,
      }, json, `Sync initialized for ${orgId}`);
      return;
    }

    case 'status': {
      const [status, links] = await Promise.all([
        requestJson<OrgFsStatusResponse>(context, `/orgs/${orgId}/fs/status`),
        requestJson<OrgFsListLinksResponse>(context, `/orgs/${orgId}/fs/links`),
      ]);
      if (json) {
        outputJson({ ...status, links_detail: links.data }, true);
        return;
      }
      console.log(`Org: ${orgId}`);
      console.log(`Gateway: ${status.gateway.status}`);
      if (status.gateway.last_heartbeat_at) console.log(`Last heartbeat: ${status.gateway.last_heartbeat_at}`);
      console.log(`Links: active=${status.links.active} paused=${status.links.paused} revoked=${status.links.revoked}`);
      console.log(`Latest seq: ${status.events.latest_seq}`);
      if (links.data.length > 0) {
        console.log('');
        for (const link of links.data) {
          console.log(`${link.id} ${link.mode} ${link.status} cursor=${link.last_cursor} lag_ms=${link.lag_ms ?? 'n/a'} backlog=${link.backlog ?? 0}`);
        }
      }
      return;
    }

    case 'logs': {
      const afterSeq = Number(getStringFlag(flags, ['after', 'after-seq', 'after_seq']) ?? '0');
      const limit = Number(getStringFlag(flags, ['limit']) ?? '200');
      const follow = flags.follow === true || flags.follow === 'true';
      if (follow) {
        await streamFsEvents(context, orgId, Number.isFinite(afterSeq) ? afterSeq : 0);
        return;
      }
      const events = await requestJson<OrgFsEventListResponse>(
        context,
        `/orgs/${orgId}/fs/events?after_seq=${Number.isFinite(afterSeq) ? afterSeq : 0}&limit=${Number.isFinite(limit) ? limit : 200}`,
      );
      outputJson(events, json);
      return;
    }

    case 'pause':
    case 'resume':
    case 'disconnect': {
      const linkId = await resolveLinkId(context, orgId, flags);
      const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'revoked';
      const updated = await requestJson(context, `/orgs/${orgId}/fs/links/${linkId}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      outputJson(updated, json, `Link ${linkId} ${nextStatus}`);
      return;
    }

    case 'mode': {
      const modeValue = getStringFlag(flags, ['set', 'mode']);
      if (!modeValue) {
        throw new Error('Usage: eve fs sync mode --org <org_id> --set <two-way|push-only|pull-only>');
      }
      const linkId = await resolveLinkId(context, orgId, flags);
      const updated = await requestJson(context, `/orgs/${orgId}/fs/links/${linkId}`, {
        method: 'PATCH',
        body: { mode: parseModeFlag(modeValue) },
      });
      outputJson(updated, json, `Link ${linkId} mode updated`);
      return;
    }

    case 'conflicts': {
      const openOnly = flags['open-only'] === true || flags['open_only'] === true || flags['open-only'] === 'true' || flags['open_only'] === 'true';
      const result = await requestJson<OrgFsListConflictsResponse>(
        context,
        `/orgs/${orgId}/fs/conflicts${openOnly ? '?open_only=true' : ''}`,
      );
      outputJson(result, json);
      return;
    }

    case 'resolve': {
      const conflictId = getStringFlag(flags, ['conflict', 'conflict-id', 'conflict_id']) ?? positionals[0];
      if (!conflictId) {
        throw new Error('Usage: eve fs sync resolve --org <org_id> --conflict <conflict_id> --strategy <pick-remote|pick-local|manual>');
      }
      const strategy = parseStrategyFlag(getStringFlag(flags, ['strategy']));
      const mergedContent = getStringFlag(flags, ['merged-content', 'merged_content']);
      const result = await requestJson(context, `/orgs/${orgId}/fs/conflicts/${conflictId}/resolve`, {
        method: 'POST',
        body: {
          strategy,
          ...(mergedContent ? { merged_content: mergedContent } : {}),
        },
      });
      outputJson(result, json, `Conflict ${conflictId} resolved`);
      return;
    }

    case 'doctor': {
      const status = await requestJson<OrgFsStatusResponse>(context, `/orgs/${orgId}/fs/status`);
      const links = await requestJson<OrgFsListLinksResponse>(context, `/orgs/${orgId}/fs/links`);
      const health = {
        auth: 'ok',
        gateway_status: status.gateway.status,
        links: links.data.length,
        active_links: links.data.filter((item) => item.status === 'active').length,
        cursor_drift: 0,
        local_path_checks: [] as Array<{ link_id: string; local_path: string; writable: boolean }>,
      };

      if (links.data.length > 0) {
        const minCursor = links.data.reduce((min, item) => Math.min(min, item.last_cursor), Number.POSITIVE_INFINITY);
        const cursorBase = Number.isFinite(minCursor) ? minCursor : 0;
        health.cursor_drift = Math.max(0, status.events.latest_seq - cursorBase);
      }

      for (const link of links.data) {
        let writable = false;
        try {
          await access(link.local_path, fsConstants.R_OK | fsConstants.W_OK);
          writable = true;
        } catch {
          writable = false;
        }
        health.local_path_checks.push({
          link_id: link.id,
          local_path: link.local_path,
          writable,
        });
      }

      outputJson(health, json, `FS sync doctor completed for ${orgId}`);
      return;
    }

    default:
      throw new Error(
        'Usage: eve fs sync <init|status|logs|pause|resume|disconnect|mode|conflicts|resolve|doctor>\n\n' +
        '  init       --org <org> --local <path> [--mode two-way|push-only|pull-only]\n' +
        '  status     --org <org>\n' +
        '  logs       --org <org> [--after N] [--limit N] [--follow]\n' +
        '  pause      --org <org> [--link <link_id>]\n' +
        '  resume     --org <org> [--link <link_id>]\n' +
        '  disconnect --org <org> [--link <link_id>]\n' +
        '  mode       --org <org> --set <two-way|push-only|pull-only> [--link <link_id>]\n' +
        '  conflicts  --org <org> [--open-only]\n' +
        '  resolve    --org <org> --conflict <id> --strategy <pick-remote|pick-local|manual>\n' +
        '  doctor     --org <org>',
      );
  }
}

export async function handleFs(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  switch (subcommand) {
    case 'sync': {
      const action = positionals[0];
      await handleSync(action, positionals.slice(1), flags, context);
      return;
    }

    case 'share': {
      // eve fs share <path> --org <org> [--expires 7d] [--label "..."]
      const orgId = getOrgOrThrow(flags, context);
      const path = positionals[0];
      if (!path) throw new Error('Usage: eve fs share <path> --org <org> [--expires <duration>] [--label <text>]');
      const body: OrgFsCreateShareRequest = {
        path,
        expires_in: getStringFlag(flags, ['expires', 'expires-in', 'ttl']) ?? undefined,
        label: getStringFlag(flags, ['label']) ?? undefined,
      };
      const json = Boolean(flags['json']);
      const share = await requestJson<OrgFsShare>(context, `/orgs/${orgId}/fs/share`, { method: 'POST', body });
      if (json) {
        outputJson(share, true);
      } else {
        console.log(`Share URL: ${share.url}`);
        if (share.expires_at) console.log(`Expires:   ${share.expires_at}`);
        if (share.label) console.log(`Label:     ${share.label}`);
        console.log(`Token:     ${share.id}`);
      }
      return;
    }

    case 'shares': {
      // eve fs shares --org <org>
      const orgId = getOrgOrThrow(flags, context);
      const json = Boolean(flags['json']);
      const result = await requestJson<OrgFsShareListResponse>(context, `/orgs/${orgId}/fs/shares`);
      outputJson(result, json, `${result.data.length} active share(s)`);
      return;
    }

    case 'revoke': {
      // eve fs revoke <token> --org <org>
      const orgId = getOrgOrThrow(flags, context);
      const token = positionals[0];
      if (!token) throw new Error('Usage: eve fs revoke <token> --org <org>');
      const json = Boolean(flags['json']);
      const share = await requestJson<OrgFsShare>(context, `/orgs/${orgId}/fs/shares/${token}`, { method: 'DELETE' });
      outputJson(share, json, `Share token ${token} revoked`);
      return;
    }

    case 'publish': {
      // eve fs publish <path-prefix> --org <org> [--label "..."]
      const orgId = getOrgOrThrow(flags, context);
      const pathPrefix = positionals[0];
      if (!pathPrefix) throw new Error('Usage: eve fs publish <path-prefix> --org <org> [--label <text>]');
      const body: OrgFsCreatePublicPathRequest = {
        path_prefix: pathPrefix,
        label: getStringFlag(flags, ['label']) ?? undefined,
      };
      const json = Boolean(flags['json']);
      const result = await requestJson(context, `/orgs/${orgId}/fs/public-paths`, { method: 'POST', body });
      outputJson(result, json, `Published path prefix: ${pathPrefix}`);
      return;
    }

    case 'public-paths': {
      // eve fs public-paths --org <org>
      const orgId = getOrgOrThrow(flags, context);
      const json = Boolean(flags['json']);
      const result = await requestJson<OrgFsPublicPathListResponse>(context, `/orgs/${orgId}/fs/public-paths`);
      outputJson(result, json, `${result.data.length} public path(s)`);
      return;
    }

    default:
      throw new Error('Usage: eve fs <sync|share|shares|revoke|publish|public-paths> ...');
  }
}

import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CloudFsMount = {
  id: string;
  org_id: string;
  project_id: string | null;
  integration_id: string;
  provider: string;
  root_folder_id: string;
  root_folder_path: string | null;
  mode: string;
  auto_index: boolean;
  label: string | null;
  changes_cursor: string | null;
  watch_channel_id: string | null;
  watch_expiry: string | null;
  metadata_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type CloudFsMountListResponse = {
  mounts: CloudFsMount[];
};

type CloudFsEntry = {
  id: string;
  name: string;
  path: string;
  mime_type: string;
  size_bytes: number | null;
  modified_at: string;
  web_url: string;
  is_folder: boolean;
};

type CloudFsBrowseResponse = {
  entries: CloudFsEntry[];
  mount_id: string;
  path: string;
  next_page_token?: string;
  truncated?: boolean;
};

type CloudFsSearchResponse = {
  entries: CloudFsEntry[];
  mount_id: string;
  next_page_token?: string;
};

type CloudFsBrowseAllResponse = CloudFsBrowseResponse & {
  complete: boolean;
  page_count: number;
};

type CloudFsSearchAllResponse = CloudFsSearchResponse & {
  complete: boolean;
  page_count: number;
};

type CloudFsOrderBy = 'name' | 'name_desc' | 'modified' | 'modified_desc';

type PagingOptions = {
  pageToken?: string;
  pageSize?: number;
  orderBy?: CloudFsOrderBy;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLOUD_FS_ORDER_BY_VALUES = new Set<CloudFsOrderBy>(['name', 'name_desc', 'modified', 'modified_desc']);
const DEFAULT_MAX_AUTO_PAGES = 200;

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

function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function getIntegerFlag(flags: Record<string, FlagValue>, keys: string[], label: string): number | undefined {
  const raw = getStringFlag(flags, keys);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function getOrderByFlag(flags: Record<string, FlagValue>): CloudFsOrderBy | undefined {
  const raw = getStringFlag(flags, ['order-by', 'order_by']);
  if (!raw) return undefined;
  if (!CLOUD_FS_ORDER_BY_VALUES.has(raw as CloudFsOrderBy)) {
    throw new Error('Invalid --order-by. Expected one of: name, name_desc, modified, modified_desc');
  }
  return raw as CloudFsOrderBy;
}

function getPagingOptions(flags: Record<string, FlagValue>): PagingOptions {
  return {
    pageToken: getStringFlag(flags, ['page-token', 'page_token']),
    pageSize: getIntegerFlag(flags, ['page-size', 'page_size'], '--page-size'),
    orderBy: getOrderByFlag(flags),
  };
}

function getMaxAutoPages(): number {
  const raw = process.env.EVE_CLOUD_FS_MAX_AUTO_PAGES;
  if (!raw) return DEFAULT_MAX_AUTO_PAGES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_AUTO_PAGES;
  return parsed;
}

function splitShortRecursiveFlag(positionals: string[]): { cleanPositionals: string[]; recursive: boolean } {
  return {
    cleanPositionals: positionals.filter((positional) => positional !== '-r'),
    recursive: positionals.includes('-r'),
  };
}

function appendPagingParams(params: URLSearchParams, options: PagingOptions): void {
  if (options.pageToken) params.set('page_token', options.pageToken);
  if (options.pageSize !== undefined) params.set('page_size', String(options.pageSize));
  if (options.orderBy) params.set('order_by', options.orderBy);
}

function warnIfNextPage(nextPageToken: string | undefined, subcommand: 'ls' | 'search'): void {
  if (!nextPageToken) return;
  console.error(`More results available. Re-run with --page-token ${nextPageToken} or use --all.`);
  void subcommand;
}

function warnIfTruncated(truncated: boolean | undefined): void {
  if (truncated) {
    console.error('Recursive listing was truncated by the server-side safety limit.');
  }
}

async function fetchBrowsePage(
  context: ResolvedContext,
  orgId: string,
  path: string,
  mountId: string | undefined,
  options: PagingOptions & { recursive?: boolean },
): Promise<CloudFsBrowseResponse> {
  const params = new URLSearchParams({ path });
  if (mountId) params.set('mount_id', mountId);
  if (options.recursive) params.set('recursive', 'true');
  appendPagingParams(params, options);
  return requestJson<CloudFsBrowseResponse>(
    context,
    `/orgs/${orgId}/cloud-fs/browse?${params.toString()}`,
  );
}

async function fetchAllBrowsePages(
  context: ResolvedContext,
  orgId: string,
  path: string,
  mountId: string | undefined,
  options: PagingOptions,
): Promise<CloudFsBrowseAllResponse> {
  const entries: CloudFsEntry[] = [];
  const maxPages = getMaxAutoPages();
  let pageToken = options.pageToken;
  let pageCount = 0;
  let latest: CloudFsBrowseResponse | undefined;

  do {
    latest = await fetchBrowsePage(context, orgId, path, mountId, { ...options, pageToken });
    entries.push(...latest.entries);
    pageToken = latest.next_page_token;
    pageCount += 1;
  } while (pageToken && pageCount < maxPages);

  if (pageToken) {
    console.error(`Stopped after ${pageCount} page(s); resume with --page-token ${pageToken}.`);
  }

  const response: CloudFsBrowseAllResponse = {
    mount_id: latest?.mount_id ?? mountId ?? '',
    path: latest?.path ?? path,
    entries,
    complete: !pageToken,
    page_count: pageCount,
  };
  if (pageToken) response.next_page_token = pageToken;
  return response;
}

async function fetchSearchPage(
  context: ResolvedContext,
  orgId: string,
  query: string,
  mountId: string | undefined,
  mimeType: string | undefined,
  options: PagingOptions,
): Promise<CloudFsSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (mountId) params.set('mount_id', mountId);
  if (mimeType) params.set('mime_type', mimeType);
  appendPagingParams(params, options);
  return requestJson<CloudFsSearchResponse>(
    context,
    `/orgs/${orgId}/cloud-fs/search?${params.toString()}`,
  );
}

async function fetchAllSearchPages(
  context: ResolvedContext,
  orgId: string,
  query: string,
  mountId: string | undefined,
  mimeType: string | undefined,
  options: PagingOptions,
): Promise<CloudFsSearchAllResponse> {
  const entries: CloudFsEntry[] = [];
  const maxPages = getMaxAutoPages();
  let pageToken = options.pageToken;
  let pageCount = 0;
  let latest: CloudFsSearchResponse | undefined;

  do {
    latest = await fetchSearchPage(context, orgId, query, mountId, mimeType, { ...options, pageToken });
    entries.push(...latest.entries);
    pageToken = latest.next_page_token;
    pageCount += 1;
  } while (pageToken && pageCount < maxPages);

  if (pageToken) {
    console.error(`Stopped after ${pageCount} page(s); resume with --page-token ${pageToken}.`);
  }

  const response: CloudFsSearchAllResponse = {
    mount_id: latest?.mount_id ?? mountId ?? '',
    entries,
    complete: !pageToken,
    page_count: pageCount,
  };
  if (pageToken) response.next_page_token = pageToken;
  return response;
}

// ---------------------------------------------------------------------------
// Table formatters
// ---------------------------------------------------------------------------

function formatMountsTable(mounts: CloudFsMount[]): void {
  if (mounts.length === 0) {
    console.log('No cloud FS mounts found.');
    return;
  }

  const idWidth = Math.max(2, ...mounts.map((m) => m.id.length));
  const providerWidth = Math.max(8, ...mounts.map((m) => m.provider.length));
  const modeWidth = Math.max(4, ...mounts.map((m) => m.mode.length));
  const labelWidth = Math.max(5, ...mounts.map((m) => (m.label ?? '-').length));

  const header = [
    padRight('ID', idWidth),
    padRight('Provider', providerWidth),
    padRight('Mode', modeWidth),
    padRight('Label', labelWidth),
    'Project',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const mount of mounts) {
    const row = [
      padRight(mount.id, idWidth),
      padRight(mount.provider, providerWidth),
      padRight(mount.mode, modeWidth),
      padRight(mount.label ?? '-', labelWidth),
      mount.project_id ?? '(org-level)',
    ].join('  ');
    console.log(row);
  }

  console.log('');
  console.log(`Total: ${mounts.length} mount(s)`);
}

function formatMountDetails(mount: CloudFsMount): void {
  console.log(`Mount: ${mount.id}`);
  console.log('');
  console.log(`  Provider:     ${mount.provider}`);
  console.log(`  Folder ID:    ${mount.root_folder_id}`);
  if (mount.root_folder_path) console.log(`  Folder Path:  ${mount.root_folder_path}`);
  console.log(`  Mode:         ${mount.mode}`);
  console.log(`  Auto-index:   ${mount.auto_index}`);
  if (mount.label) console.log(`  Label:        ${mount.label}`);
  console.log(`  Org:          ${mount.org_id}`);
  if (mount.project_id) console.log(`  Project:      ${mount.project_id}`);
  console.log(`  Integration:  ${mount.integration_id}`);
  if (mount.created_by) console.log(`  Created by:   ${mount.created_by}`);
  console.log(`  Created:      ${formatTimestamp(mount.created_at)}`);
  console.log(`  Updated:      ${formatTimestamp(mount.updated_at)}`);
  if (mount.watch_channel_id) {
    console.log(`  Watch:        channel=${mount.watch_channel_id} expires=${formatTimestamp(mount.watch_expiry)}`);
  }
}

function formatEntriesTable(entries: CloudFsEntry[], path: string, options: { showPath?: boolean } = {}): void {
  if (entries.length === 0) {
    console.log(`No files found at ${path}`);
    return;
  }

  const displayName = (entry: CloudFsEntry): string => {
    const value = options.showPath ? entry.path : entry.name;
    return entry.is_folder ? `${value}/` : value;
  };

  const nameWidth = Math.max(4, ...entries.map((e) => displayName(e).length));
  const typeWidth = Math.max(4, ...entries.map((e) => (e.is_folder ? 'folder' : e.mime_type).length));
  const sizeWidth = Math.max(4, ...entries.map((e) => formatBytes(e.size_bytes).length));

  const header = [
    padRight('Name', nameWidth),
    padRight('Type', typeWidth),
    padRight('Size', sizeWidth),
    'Modified',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  // Folders first, then files
  const sorted = [...entries].sort((a, b) => {
    if (a.is_folder !== b.is_folder) return a.is_folder ? -1 : 1;
    return displayName(a).localeCompare(displayName(b));
  });

  for (const entry of sorted) {
    const displayType = entry.is_folder ? 'folder' : entry.mime_type;
    const row = [
      padRight(displayName(entry), nameWidth),
      padRight(displayType, typeWidth),
      padRight(formatBytes(entry.size_bytes), sizeWidth),
      formatTimestamp(entry.modified_at),
    ].join('  ');
    console.log(row);
  }

  console.log('');
  console.log(`Total: ${entries.length} item(s)`);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function handleCloudFs(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = getBooleanFlag(flags, ['json']) ?? false;
  const orgId = getOrgOrThrow(flags, context);

  switch (subcommand) {
    case 'list': {
      const projectId = getStringFlag(flags, ['project', 'project-id', 'project_id']);
      const params = new URLSearchParams();
      if (projectId) params.set('project_id', projectId);
      const suffix = params.toString() ? `?${params.toString()}` : '';

      const response = await requestJson<CloudFsMountListResponse>(
        context,
        `/orgs/${orgId}/cloud-fs/mounts${suffix}`,
      );

      if (json) {
        outputJson(response, true);
      } else {
        formatMountsTable(response.mounts);
      }
      return;
    }

    case 'mount': {
      const provider = getStringFlag(flags, ['provider']);
      const folderId = getStringFlag(flags, ['folder-id', 'folder_id']);
      if (!provider || !folderId) {
        throw new Error(
          'Usage: eve cloud-fs mount --provider <provider> --folder-id <id> [options]\n\n' +
          '  --provider <name>       Cloud storage provider (e.g., google-drive)\n' +
          '  --folder-id <id>        Provider folder ID to mount\n' +
          '  --project <id>          Scope mount to a project (default: org-level)\n' +
          '  --label <text>          Human-readable label\n' +
          '  --integration <id>      Integration to use (auto-detected if omitted)\n' +
          '  --mode <mode>           Access mode: read_only, write_only, read_write (default: read_write)\n' +
          '  --auto-index <bool>     Auto-index files to org docs (default: true)',
        );
      }

      // Normalize provider name: google-drive -> google_drive
      const normalizedProvider = provider.replace(/-/g, '_');

      const body: Record<string, unknown> = {
        provider: normalizedProvider,
        root_folder_id: folderId,
      };

      const projectId = getStringFlag(flags, ['project', 'project-id', 'project_id']);
      const label = getStringFlag(flags, ['label']);
      const integrationId = getStringFlag(flags, ['integration', 'integration-id', 'integration_id']);
      const mode = getStringFlag(flags, ['mode']);
      const autoIndex = getStringFlag(flags, ['auto-index', 'auto_index']);

      if (projectId) body.project_id = projectId;
      if (label) body.label = label;
      if (integrationId) body.integration_id = integrationId;
      if (mode) body.mode = mode;
      if (autoIndex !== undefined) body.auto_index = autoIndex !== 'false';

      const mount = await requestJson<CloudFsMount>(
        context,
        `/orgs/${orgId}/cloud-fs/mounts`,
        { method: 'POST', body },
      );

      if (json) {
        outputJson(mount, true);
      } else {
        console.log(`Mount created: ${mount.id}`);
        console.log(`  Provider:    ${mount.provider}`);
        console.log(`  Folder ID:   ${mount.root_folder_id}`);
        if (mount.root_folder_path) console.log(`  Folder Path: ${mount.root_folder_path}`);
        console.log(`  Mode:        ${mount.mode}`);
        if (mount.label) console.log(`  Label:       ${mount.label}`);
        if (mount.project_id) console.log(`  Project:     ${mount.project_id}`);
      }
      return;
    }

    case 'unmount':
    case 'remove':
    case 'delete': {
      const mountId = positionals[0];
      if (!mountId) {
        throw new Error('Usage: eve cloud-fs unmount <mount_id>');
      }

      await requestJson(
        context,
        `/orgs/${orgId}/cloud-fs/mounts/${mountId}`,
        { method: 'DELETE' },
      );

      outputJson({ id: mountId, deleted: true }, json, `Mount ${mountId} removed`);
      return;
    }

    case 'show': {
      const mountId = positionals[0];
      if (!mountId) {
        throw new Error('Usage: eve cloud-fs show <mount_id>');
      }

      const mount = await requestJson<CloudFsMount>(
        context,
        `/orgs/${orgId}/cloud-fs/mounts/${mountId}`,
      );

      if (json) {
        outputJson(mount, true);
      } else {
        formatMountDetails(mount);
      }
      return;
    }

    case 'update': {
      const mountId = positionals[0];
      if (!mountId) {
        throw new Error(
          'Usage: eve cloud-fs update <mount_id> [--label <text>] [--mode <mode>] [--auto-index <bool>]',
        );
      }

      const body: Record<string, unknown> = {};
      const label = getStringFlag(flags, ['label']);
      const mode = getStringFlag(flags, ['mode']);
      const autoIndex = getStringFlag(flags, ['auto-index', 'auto_index']);

      if (label !== undefined) body.label = label;
      if (mode !== undefined) body.mode = mode;
      if (autoIndex !== undefined) body.auto_index = autoIndex !== 'false';

      if (Object.keys(body).length === 0) {
        throw new Error(
          'Nothing to update. Provide at least one of: --label, --mode, --auto-index',
        );
      }

      const mount = await requestJson<CloudFsMount>(
        context,
        `/orgs/${orgId}/cloud-fs/mounts/${mountId}`,
        { method: 'PATCH', body },
      );

      outputJson(mount, json, `Mount ${mountId} updated`);
      return;
    }

    case 'ls':
    case 'browse': {
      const { cleanPositionals, recursive: shortRecursive } = splitShortRecursiveFlag(positionals);
      const path = cleanPositionals[0] ?? '/';
      const mountId = getStringFlag(flags, ['mount', 'mount-id', 'mount_id']);
      const all = getBooleanFlag(flags, ['all']) ?? false;
      const recursive = (getBooleanFlag(flags, ['recursive']) ?? false) || shortRecursive;
      const pagingOptions = getPagingOptions(flags);

      if (recursive && pagingOptions.pageToken) {
        throw new Error('eve cloud-fs ls --recursive cannot be used with --page-token');
      }
      if (recursive && all) {
        throw new Error('eve cloud-fs ls --recursive cannot be used with --all');
      }

      const response = all
        ? await fetchAllBrowsePages(context, orgId, path, mountId, pagingOptions)
        : await fetchBrowsePage(context, orgId, path, mountId, { ...pagingOptions, recursive });

      if (json) {
        outputJson(response, true);
      } else {
        formatEntriesTable(response.entries, response.path, { showPath: recursive });
        if (!all) {
          warnIfNextPage(response.next_page_token, 'ls');
          warnIfTruncated(response.truncated);
        }
      }
      return;
    }

    case 'search': {
      const query = positionals[0] ?? getStringFlag(flags, ['query', 'q']);
      if (!query) {
        throw new Error(
          'Usage: eve cloud-fs search <query> [--mount <mount_id>] [--mime-type <type>] [--all] [--page-token <token>] [--page-size <n>] [--order-by <value>]',
        );
      }

      const mountId = getStringFlag(flags, ['mount', 'mount-id', 'mount_id']);
      const mimeType = getStringFlag(flags, ['mime-type', 'mime_type']);
      const all = getBooleanFlag(flags, ['all']) ?? false;
      const pagingOptions = getPagingOptions(flags);
      const response = all
        ? await fetchAllSearchPages(context, orgId, query, mountId, mimeType, pagingOptions)
        : await fetchSearchPage(context, orgId, query, mountId, mimeType, pagingOptions);

      if (json) {
        outputJson(response, true);
      } else {
        if (response.entries.length === 0) {
          console.log(`No results for "${query}"`);
        } else {
          formatEntriesTable(response.entries, `search: ${query}`);
        }
        if (!all) warnIfNextPage(response.next_page_token, 'search');
      }
      return;
    }

    default:
      throw new Error(
        'Usage: eve cloud-fs <list|mount|unmount|show|update|ls|search>\n\n' +
        '  list       List all mounts for the current org\n' +
        '  mount      Create a new cloud FS mount\n' +
        '  unmount    Remove a mount\n' +
        '  show       Show mount details\n' +
        '  update     Update mount settings\n' +
        '  ls         Browse files at a path, with optional paging\n' +
        '  search     Search files across mounts\n\n' +
        'Examples:\n' +
        '  eve cloud-fs list\n' +
        '  eve cloud-fs mount --provider google-drive --folder-id 0ABxxx --label "Shared Drive"\n' +
        '  eve cloud-fs show cfm_xxx\n' +
        '  eve cloud-fs ls / --mount cfm_xxx\n' +
        '  eve cloud-fs search "Q4 report"',
      );
  }
}

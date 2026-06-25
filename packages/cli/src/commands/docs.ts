import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath, relative as relativePath } from 'node:path';
import type { FlagValue } from '../lib/args';
import { getStringFlag, getBooleanFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

function encodeDocPathParam(path: string): string {
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  return encodeURIComponent(trimmed);
}

function parseWhereClause(raw: string): Record<string, Record<string, unknown>> {
  const clauses = raw.split(';').map((entry) => entry.trim()).filter(Boolean);
  const result: Record<string, Record<string, unknown>> = {};

  for (const clause of clauses) {
    const match = clause.match(/^([^\s]+)\s+(eq|in|gte|lte|exists|prefix)\s+(.+)$/i);
    if (!match) {
      throw new Error(`Invalid --where clause: ${clause}`);
    }
    const field = match[1];
    const op = match[2].toLowerCase();
    const valueRaw = match[3].trim();

    if (op === 'exists') {
      const normalized = valueRaw.toLowerCase();
      const exists = ['true', '1', 'yes', 'y'].includes(normalized);
      result[field] = { exists };
      continue;
    }

    if (op === 'in') {
      const values = valueRaw.split(',').map((item) => item.trim()).filter(Boolean);
      result[field] = { in: values };
      continue;
    }

    if (op === 'gte' || op === 'lte') {
      const parsed = Number(valueRaw);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric value for ${op}: ${valueRaw}`);
      }
      result[field] = { [op]: parsed };
      continue;
    }

    if (op === 'prefix') {
      result[field] = { prefix: valueRaw };
      continue;
    }

    result[field] = { eq: valueRaw };
  }

  return result;
}

function parseFutureIsoOrDuration(raw: string, flagName: string): string {
  const trimmed = raw.trim();
  const durationMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (durationMatch) {
    const value = Number.parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const ms = unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : 86_400_000;
    return new Date(Date.now() + (value * ms)).toISOString();
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${flagName}: ${raw}. Use ISO timestamp or duration like 30d.`);
  }
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Tree view helpers
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  type: 'directory' | 'document';
  path?: string;
  children?: TreeNode[];
}

function buildTreeNodes(docs: { path: string }[]): TreeNode[] {
  const root: Record<string, unknown> = {};
  for (const doc of docs) {
    const parts = doc.path.split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = { __leaf: true, __path: doc.path };
      } else {
        if (!current[part] || (current[part] as Record<string, unknown>).__leaf) {
          current[part] = current[part] ?? {};
        }
        current = current[part] as Record<string, unknown>;
      }
    }
  }

  function toNodes(obj: Record<string, unknown>, parentPath: string): TreeNode[] {
    const entries = Object.entries(obj).filter(([k]) => !k.startsWith('__'));
    return entries.map(([name, value]) => {
      const val = value as Record<string, unknown>;
      if (val.__leaf) {
        return { name, type: 'document' as const, path: val.__path as string };
      }
      const childPath = parentPath ? `${parentPath}/${name}` : `/${name}`;
      return { name, type: 'directory' as const, children: toNodes(val, childPath) };
    });
  }

  return toNodes(root, '');
}

function renderTreeText(nodes: TreeNode[], prefix = ''): string {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const suffix = node.type === 'directory' ? '/' : '';
    lines.push(`${prefix}${connector}${node.name}${suffix}`);
    if (node.children) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      lines.push(renderTreeText(node.children, childPrefix));
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Unified diff helper
// ---------------------------------------------------------------------------

function computeUnifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce edit script
  const edits: Array<{ type: 'keep' | 'del' | 'add'; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      edits.push({ type: 'keep', line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ type: 'add', line: newLines[j - 1] });
      j--;
    } else {
      edits.push({ type: 'del', line: oldLines[i - 1] });
      i--;
    }
  }
  edits.reverse();

  // Format as unified diff with context
  const output: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  const CONTEXT = 3;
  let hunkStart = -1;
  const hunkLines: string[] = [];
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  let oldLineNum = 0;
  let newLineNum = 0;
  let trailingContext = 0;

  function flushHunk() {
    if (hunkLines.length > 0) {
      output.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
      output.push(...hunkLines);
      hunkLines.length = 0;
    }
  }

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx];
    if (edit.type === 'keep') {
      oldLineNum++;
      newLineNum++;
      if (hunkStart >= 0) {
        trailingContext++;
        hunkLines.push(` ${edit.line}`);
        oldCount++;
        newCount++;
        if (trailingContext >= CONTEXT) {
          // Check if next non-keep is close enough to merge
          let nextChange = -1;
          for (let k = idx + 1; k < edits.length && k <= idx + CONTEXT * 2; k++) {
            if (edits[k].type !== 'keep') { nextChange = k; break; }
          }
          if (nextChange === -1) {
            flushHunk();
            hunkStart = -1;
            trailingContext = 0;
          }
        }
      }
    } else {
      trailingContext = 0;
      if (hunkStart < 0) {
        hunkStart = idx;
        oldStart = oldLineNum;
        newStart = newLineNum;
        oldCount = 0;
        newCount = 0;
        // Add leading context
        const contextStart = Math.max(0, idx - CONTEXT);
        let oBack = oldLineNum;
        let nBack = newLineNum;
        for (let k = idx - 1; k >= contextStart; k--) {
          if (edits[k].type === 'keep') { oBack--; nBack--; }
        }
        oldStart = oBack;
        newStart = nBack;
        for (let k = contextStart; k < idx; k++) {
          if (edits[k].type === 'keep') {
            hunkLines.push(` ${edits[k].line}`);
            oldCount++;
            newCount++;
          }
        }
      }
      if (edit.type === 'del') {
        hunkLines.push(`-${edit.line}`);
        oldLineNum++;
        oldCount++;
      } else {
        hunkLines.push(`+${edit.line}`);
        newLineNum++;
        newCount++;
      }
    }
  }
  flushHunk();

  if (output.length === 2) {
    return '(no differences)';
  }
  return output.join('\n');
}

// ---------------------------------------------------------------------------
// Directory walking helper
// ---------------------------------------------------------------------------

function walkDirectory(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = joinPath(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirectory(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export async function handleDocs(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;

  if (!orgId) {
    throw new Error('Missing org id. Provide --org or set a profile default.');
  }

  switch (subcommand) {
    case 'write':
    case 'create': {
      const docPath = getStringFlag(flags, ['path']);
      if (!docPath) {
        throw new Error('Usage: eve docs write --org <org_id> --path <doc_path> --file <path> | --stdin');
      }

      let content: string;
      const filePath = getStringFlag(flags, ['file']);
      const useStdin = flags.stdin === true || flags.stdin === 'true';

      if (filePath) {
        content = readFileSync(resolvePath(filePath), 'utf-8');
      } else if (useStdin) {
        content = readFileSync(0, 'utf-8');
      } else {
        throw new Error('Provide --file <path> or --stdin to supply document content');
      }

      const mimeType = getStringFlag(flags, ['mime-type', 'mime_type']);
      const projectId = getStringFlag(flags, ['project', 'project-id', 'project_id']);
      const metadataRaw = getStringFlag(flags, ['metadata']);
      let metadata: Record<string, unknown> | undefined;
      if (metadataRaw) {
        try {
          metadata = JSON.parse(metadataRaw);
        } catch {
          throw new Error('Invalid --metadata JSON');
        }
      }
      const lifecycleStatus = getStringFlag(flags, ['lifecycle-status', 'lifecycle_status']);
      const reviewIn = getStringFlag(flags, ['review-in', 'review_in']);
      const reviewDueRaw = getStringFlag(flags, ['review-due', 'review_due']);
      if (reviewIn && reviewDueRaw) {
        throw new Error('Specify only one of --review-in or --review-due');
      }
      const expiresIn = getStringFlag(flags, ['expires-in', 'expires_in']);
      const expiresAtRaw = getStringFlag(flags, ['expires-at', 'expires_at']);
      if (expiresIn && expiresAtRaw) {
        throw new Error('Specify only one of --expires-in or --expires-at');
      }
      const reviewDue = reviewDueRaw
        ? parseFutureIsoOrDuration(reviewDueRaw, '--review-due')
        : (reviewIn ? parseFutureIsoOrDuration(reviewIn, '--review-in') : undefined);
      const expiresAt = expiresAtRaw
        ? parseFutureIsoOrDuration(expiresAtRaw, '--expires-at')
        : (expiresIn ? parseFutureIsoOrDuration(expiresIn, '--expires-in') : undefined);

      // Try reading the existing document
      const existing = await requestJson<{ id?: string } | null>(
        context,
        `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
        { method: 'GET', allowError: true },
      );

      let result: unknown;
      if (existing && typeof existing === 'object' && 'id' in existing) {
        // Document exists: update via PUT
        const updateBody: Record<string, unknown> = {
          content,
          ...(mimeType ? { mime_type: mimeType } : {}),
          ...(metadata ? { metadata } : {}),
          ...(reviewDue ? { review_due: reviewDue } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...(lifecycleStatus ? { lifecycle_status: lifecycleStatus } : {}),
        };
        result = await requestJson(
          context,
          `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
          { method: 'PUT', body: updateBody },
        );
      } else {
        // Document does not exist: create via POST
        result = await requestJson(context, `/orgs/${orgId}/docs`, {
          method: 'POST',
          body: {
            path: docPath,
            content,
            ...(mimeType ? { mime_type: mimeType } : {}),
            ...(projectId ? { project_id: projectId } : {}),
            ...(metadata ? { metadata } : {}),
            ...(reviewDue ? { review_due: reviewDue } : {}),
            ...(expiresAt ? { expires_at: expiresAt } : {}),
            ...(lifecycleStatus ? { lifecycle_status: lifecycleStatus } : {}),
          },
        });
      }

      outputJson(result, json, `Document written: ${docPath}`);
      return;
    }

    case 'read': {
      const docPath = getStringFlag(flags, ['path']) ?? positionals[0];
      if (!docPath) {
        throw new Error('Usage: eve docs read --org <org_id> --path <doc_path>');
      }

      const version = getStringFlag(flags, ['version']);
      if (version) {
        const encodedPath = encodeDocPathParam(docPath);
        const result = await requestJson<{ content: string }>(
          context,
          `/orgs/${orgId}/docs/${encodedPath}/versions/${version}`,
        );
        if (json) {
          outputJson(result, json);
        } else {
          console.log(result.content);
        }
        return;
      }

      const result = await requestJson<{ content: string }>(
        context,
        `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
      );

      if (json) {
        outputJson(result, json);
      } else {
        // Raw content output for piping
        console.log(result.content);
      }
      return;
    }

    case 'show': {
      const docPath = getStringFlag(flags, ['path']) ?? positionals[0];
      if (!docPath) {
        throw new Error('Usage: eve docs show --org <org_id> --path <doc_path> [--verbose]');
      }
      const verbose = flags.verbose === true || flags.verbose === 'true';
      const result = await requestJson<Record<string, unknown>>(
        context,
        `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
      );

      if (json) {
        outputJson(result, json);
        return;
      }

      console.log(`${result.path ?? docPath}`);
      if (result.id) console.log(`  id: ${result.id}`);
      if (result.current_version) console.log(`  version: ${result.current_version}`);
      if (result.content_hash) console.log(`  hash: ${result.content_hash}`);
      if (result.updated_at) console.log(`  updated: ${result.updated_at}`);
      if (verbose) {
        if (result.latest_mutation_id) console.log(`  mutation: ${result.latest_mutation_id}`);
        if (result.metadata) console.log(`  metadata: ${JSON.stringify(result.metadata)}`);
      }
      return;
    }

    case 'list': {
      const prefix = getStringFlag(flags, ['path']) ?? positionals[0] ?? '';
      const query = prefix ? `?path=${encodeURIComponent(prefix)}` : '';
      const result = await requestJson<{ documents: { path: string }[] }>(
        context, `/orgs/${orgId}/docs${query}`,
      );
      const tree = getBooleanFlag(flags, ['tree']);
      if (tree) {
        const nodes = buildTreeNodes(result.documents);
        if (json) {
          console.log(JSON.stringify({ tree: nodes }));
        } else {
          console.log(renderTreeText(nodes));
        }
        return;
      }
      outputJson(result, json);
      return;
    }

    case 'search': {
      const query = getStringFlag(flags, ['query', 'q']) ?? positionals[0];
      if (!query) {
        throw new Error('Usage: eve docs search --org <org_id> --query "search terms"');
      }
      const limit = getStringFlag(flags, ['limit']);
      const mode = getStringFlag(flags, ['mode']);
      const pathPrefix = getStringFlag(flags, ['path']);
      const contextLines = getStringFlag(flags, ['context']);
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', limit);
      if (mode) params.set('mode', mode);
      if (pathPrefix) params.set('path_prefix', pathPrefix);
      const result = await requestJson<{
        documents: Array<{
          path: string;
          rank: number;
          headline: string;
          [key: string]: unknown;
        }>;
      }>(context, `/orgs/${orgId}/docs/search?${params.toString()}`);

      if (contextLines && Number(contextLines) > 0) {
        const ctx = Number(contextLines);
        // Fetch full content for each result and extract context around query matches
        const enriched = await Promise.all(
          result.documents.map(async (doc) => {
            try {
              const full = await requestJson<{ content: string }>(
                context,
                `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(doc.path)}`,
              );
              const lines = full.content.split('\n');
              const queryLower = query.toLowerCase();
              const matchIndices: number[] = [];
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(queryLower)) {
                  matchIndices.push(i);
                }
              }
              if (matchIndices.length === 0) {
                return { ...doc, context_lines: lines.slice(0, ctx * 2 + 1).join('\n') };
              }
              // Merge context ranges
              const ranges: [number, number][] = [];
              for (const idx of matchIndices) {
                const start = Math.max(0, idx - ctx);
                const end = Math.min(lines.length - 1, idx + ctx);
                if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
                  ranges[ranges.length - 1][1] = end;
                } else {
                  ranges.push([start, end]);
                }
              }
              const contextContent = ranges
                .map(([s, e]) => lines.slice(s, e + 1).join('\n'))
                .join('\n---\n');
              return { ...doc, context_lines: contextContent };
            } catch {
              return doc;
            }
          }),
        );
        outputJson({ documents: enriched }, json);
        return;
      }

      outputJson(result, json);
      return;
    }

    case 'stale': {
      const overdueBy = getStringFlag(flags, ['overdue-by', 'overdue_by']);
      const prefix = getStringFlag(flags, ['prefix', 'path']);
      const limit = getStringFlag(flags, ['limit']);
      const params = new URLSearchParams();
      if (overdueBy) params.set('overdue_by', overdueBy);
      if (prefix) params.set('prefix', prefix);
      if (limit) params.set('limit', limit);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson(context, `/orgs/${orgId}/docs/stale${suffix}`);
      outputJson(result, json);
      return;
    }

    case 'review': {
      const docPath = getStringFlag(flags, ['path']) ?? positionals[0];
      if (!docPath) {
        throw new Error('Usage: eve docs review --org <org_id> --path <doc_path> --next-review <duration|iso>');
      }
      const nextReviewRaw = getStringFlag(flags, ['next-review', 'next_review']);
      if (!nextReviewRaw) {
        throw new Error('Usage: eve docs review --org <org_id> --path <doc_path> --next-review <duration|iso>');
      }
      const nextReview = parseFutureIsoOrDuration(nextReviewRaw, '--next-review');
      const result = await requestJson(
        context,
        `/orgs/${orgId}/docs/review?path=${encodeURIComponent(docPath)}`,
        {
          method: 'POST',
          body: { next_review: nextReview },
        },
      );
      outputJson(result, json, `Document reviewed: ${docPath}`);
      return;
    }

    case 'versions': {
      const docPath = getStringFlag(flags, ['path']) ?? positionals[0];
      if (!docPath) {
        throw new Error('Usage: eve docs versions --org <org_id> --path <doc_path>');
      }
      const encodedPath = encodeDocPathParam(docPath);
      const params = new URLSearchParams();
      const limit = getStringFlag(flags, ['limit']);
      const offset = getStringFlag(flags, ['offset']);
      if (limit) params.set('limit', limit);
      if (offset) params.set('offset', offset);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson(context, `/orgs/${orgId}/docs/${encodedPath}/versions${suffix}`);
      outputJson(result, json);
      return;
    }

    case 'query': {
      const pathPrefix = getStringFlag(flags, ['path-prefix', 'path_prefix']) ?? undefined;
      const whereRaw = getStringFlag(flags, ['where']);
      const sortRaw = getStringFlag(flags, ['sort']);
      const limit = getStringFlag(flags, ['limit']);
      const cursor = getStringFlag(flags, ['cursor']);

      const body: Record<string, unknown> = {};
      if (pathPrefix) body.path_prefix = pathPrefix;
      if (whereRaw) body.where = parseWhereClause(whereRaw);
      if (sortRaw) {
        const [field, direction] = sortRaw.split(':');
        if (!field || !direction) {
          throw new Error('Invalid --sort value. Use field:direction');
        }
        body.sort = [{ field, direction }];
      }
      if (limit) body.limit = Number(limit);
      if (cursor) body.cursor = cursor;

      const result = await requestJson(context, `/orgs/${orgId}/docs/query`, {
        method: 'POST',
        body,
      });
      outputJson(result, json);
      return;
    }

    case 'delete': {
      const docPath = getStringFlag(flags, ['path']) ?? positionals[0];
      if (!docPath) {
        throw new Error('Usage: eve docs delete --org <org_id> --path <doc_path>');
      }
      const result = await requestJson(
        context,
        `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
        { method: 'DELETE' },
      );
      outputJson(result, json, `Document deleted: ${docPath}`);
      return;
    }

    // ------------------------------------------------------------------
    // Patch (Enhancement 2)
    // ------------------------------------------------------------------

    case 'patch': {
      const docPath = getStringFlag(flags, ['path']);
      if (!docPath) {
        throw new Error(
          'Usage: eve docs patch --org <org_id> --path <doc_path>\n' +
          '  --replace "search" "replacement"\n' +
          '  --append "content"\n' +
          '  --insert-after "anchor" "content"\n' +
          '  --operations \'[{"op":"replace","search":"old","replace":"new"}]\'',
        );
      }

      const replaceSearch = getStringFlag(flags, ['replace']);
      const appendContent = getStringFlag(flags, ['append']);
      const insertAfterAnchor = getStringFlag(flags, ['insert-after', 'insert_after']);
      const operationsRaw = getStringFlag(flags, ['operations']);

      type PatchOp =
        | { op: 'replace'; search: string; replace: string }
        | { op: 'append'; content: string }
        | { op: 'insert_after'; anchor: string; content: string };
      let operations: PatchOp[];

      if (operationsRaw) {
        if (replaceSearch !== undefined || appendContent !== undefined || insertAfterAnchor !== undefined) {
          throw new Error('Cannot use --operations with --replace, --append, or --insert-after');
        }
        operations = JSON.parse(operationsRaw) as PatchOp[];
      } else {
        operations = [];
        let posIdx = 0;
        if (replaceSearch !== undefined) {
          const replaceWith = positionals[posIdx++];
          if (replaceWith === undefined) {
            throw new Error('--replace requires: --replace "search text" "replacement text"');
          }
          operations.push({ op: 'replace', search: replaceSearch, replace: replaceWith });
        }
        if (appendContent !== undefined) {
          operations.push({ op: 'append', content: appendContent });
        }
        if (insertAfterAnchor !== undefined) {
          const insertContent = positionals[posIdx++];
          if (insertContent === undefined) {
            throw new Error('--insert-after requires: --insert-after "anchor text" "content to insert"');
          }
          operations.push({ op: 'insert_after', anchor: insertAfterAnchor, content: insertContent });
        }
      }

      if (operations.length === 0) {
        throw new Error('No patch operations specified. Use --replace, --append, --insert-after, or --operations.');
      }

      const result = await requestJson(
        context,
        `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
        { method: 'PATCH', body: { operations } },
      );
      outputJson(result, json, `Document patched: ${docPath}`);
      return;
    }

    // ------------------------------------------------------------------
    // Diff (Enhancement 5)
    // ------------------------------------------------------------------

    case 'diff': {
      const docPath = getStringFlag(flags, ['path']);
      if (!docPath) {
        throw new Error('Usage: eve docs diff --org <org_id> --path <doc_path> [--from N] [--to N] [--unified]');
      }
      const fromStr = getStringFlag(flags, ['from']);
      const toStr = getStringFlag(flags, ['to']);
      const encodedPath = encodeDocPathParam(docPath);

      // Determine versions
      let fromVersion: number;
      let toVersion: number;

      if (toStr) {
        toVersion = Number(toStr);
      } else {
        // Default to latest
        const versions = await requestJson<{ versions: { version: number }[] }>(
          context, `/orgs/${orgId}/docs/${encodedPath}/versions?limit=1`,
        );
        if (versions.versions.length === 0) {
          throw new Error(`No versions found for ${docPath}`);
        }
        toVersion = versions.versions[0].version;
      }

      if (fromStr) {
        fromVersion = Number(fromStr);
      } else {
        fromVersion = Math.max(1, toVersion - 1);
      }

      if (fromVersion === toVersion) {
        console.log('(no differences — same version)');
        return;
      }

      const [oldVer, newVer] = await Promise.all([
        requestJson<{ content: string; version: number }>(
          context, `/orgs/${orgId}/docs/${encodedPath}/versions/${fromVersion}`,
        ),
        requestJson<{ content: string; version: number }>(
          context, `/orgs/${orgId}/docs/${encodedPath}/versions/${toVersion}`,
        ),
      ]);

      if (json) {
        console.log(JSON.stringify({
          path: docPath,
          from_version: fromVersion,
          to_version: toVersion,
          diff: computeUnifiedDiff(
            oldVer.content, newVer.content,
            `${docPath} (v${fromVersion})`, `${docPath} (v${toVersion})`,
          ),
        }));
        return;
      }

      console.log(computeUnifiedDiff(
        oldVer.content, newVer.content,
        `${docPath} (v${fromVersion})`, `${docPath} (v${toVersion})`,
      ));
      return;
    }

    // ------------------------------------------------------------------
    // Write directory (Enhancement 6)
    // ------------------------------------------------------------------

    case 'write-dir': {
      const source = getStringFlag(flags, ['source']);
      const pathPrefixFlag = getStringFlag(flags, ['path-prefix', 'path_prefix']) ?? '';
      if (!source) {
        throw new Error('Usage: eve docs write-dir --org <org_id> --source <dir> [--path-prefix <prefix>]');
      }
      const resolvedSource = resolvePath(source);
      if (!existsSync(resolvedSource)) {
        throw new Error(`Source directory not found: ${resolvedSource}`);
      }

      const files = walkDirectory(resolvedSource);
      let created = 0;
      let updated = 0;
      for (const file of files) {
        const rel = relativePath(resolvedSource, file);
        const docPath = pathPrefixFlag
          ? `${pathPrefixFlag.replace(/\/$/, '')}/${rel}`
          : `/${rel}`;
        const content = readFileSync(file, 'utf-8');

        const existing = await requestJson<{ id?: string } | null>(
          context,
          `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`,
          { method: 'GET', allowError: true },
        );

        if (existing && typeof existing === 'object' && 'id' in existing) {
          await requestJson(context, `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`, {
            method: 'PUT', body: { content },
          });
          updated++;
        } else {
          await requestJson(context, `/orgs/${orgId}/docs`, {
            method: 'POST', body: { path: docPath, content },
          });
          created++;
        }
      }

      if (json) {
        console.log(JSON.stringify({ created, updated, total: files.length }));
      } else {
        console.log(`write-dir: ${created} created, ${updated} updated (${files.length} files)`);
      }
      return;
    }

    // ------------------------------------------------------------------
    // Bulk write from NDJSON (Enhancement 6)
    // ------------------------------------------------------------------

    case 'bulk-write': {
      const input = readFileSync(0, 'utf-8');
      const lines = input.split('\n').filter((l) => l.trim());
      let created = 0;
      let updated = 0;
      let errors = 0;

      for (const line of lines) {
        const doc = JSON.parse(line) as { path: string; content: string; metadata?: Record<string, unknown> };
        if (!doc.path || !doc.content) {
          console.error(`Skipping invalid line (missing path or content): ${line.slice(0, 80)}`);
          errors++;
          continue;
        }

        const existing = await requestJson<{ id?: string } | null>(
          context,
          `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(doc.path)}`,
          { method: 'GET', allowError: true },
        );

        if (existing && typeof existing === 'object' && 'id' in existing) {
          await requestJson(context, `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(doc.path)}`, {
            method: 'PUT', body: { content: doc.content, ...(doc.metadata ? { metadata: doc.metadata } : {}) },
          });
          updated++;
        } else {
          await requestJson(context, `/orgs/${orgId}/docs`, {
            method: 'POST', body: { path: doc.path, content: doc.content, ...(doc.metadata ? { metadata: doc.metadata } : {}) },
          });
          created++;
        }
      }

      if (json) {
        console.log(JSON.stringify({ created, updated, errors, total: lines.length }));
      } else {
        console.log(`bulk-write: ${created} created, ${updated} updated, ${errors} errors (${lines.length} lines)`);
      }
      return;
    }

    // ------------------------------------------------------------------
    // Sync (Enhancement 6)
    // ------------------------------------------------------------------

    case 'sync': {
      const source = getStringFlag(flags, ['source']);
      const pathPrefixFlag = getStringFlag(flags, ['path-prefix', 'path_prefix']) ?? '';
      const dryRun = getBooleanFlag(flags, ['dry-run', 'dry_run']) ?? false;
      const doDelete = getBooleanFlag(flags, ['delete']) ?? false;

      if (!source) {
        throw new Error('Usage: eve docs sync --org <org_id> --source <dir> --path-prefix <prefix> [--dry-run] [--delete]');
      }
      const resolvedSource = resolvePath(source);
      if (!existsSync(resolvedSource)) {
        throw new Error(`Source directory not found: ${resolvedSource}`);
      }

      // Build set of local file paths (as doc paths)
      const localFiles = walkDirectory(resolvedSource);
      const localPaths = new Set(
        localFiles.map((f) => {
          const rel = relativePath(resolvedSource, f);
          return pathPrefixFlag ? `${pathPrefixFlag.replace(/\/$/, '')}/${rel}` : `/${rel}`;
        }),
      );

      // List remote docs under prefix
      const prefix = pathPrefixFlag || '/';
      const remote = await requestJson<{ documents: { path: string }[] }>(
        context, `/orgs/${orgId}/docs?path=${encodeURIComponent(prefix)}`,
      );
      const remotePaths = new Set(remote.documents.map((d) => d.path));

      const toCreate = [...localPaths].filter((p) => !remotePaths.has(p));
      const toUpdate = [...localPaths].filter((p) => remotePaths.has(p));
      const toDeletePaths = doDelete ? [...remotePaths].filter((p) => !localPaths.has(p)) : [];

      if (dryRun) {
        const summary = { create: toCreate.length, update: toUpdate.length, delete: toDeletePaths.length };
        if (json) {
          console.log(JSON.stringify({ ...summary, dry_run: true, paths: { create: toCreate, update: toUpdate, delete: toDeletePaths } }));
        } else {
          console.log(`sync (dry-run): ${summary.create} to create, ${summary.update} to update, ${summary.delete} to delete`);
          if (toDeletePaths.length > 0) {
            for (const p of toDeletePaths) console.log(`  delete: ${p}`);
          }
        }
        return;
      }

      let created = 0;
      let updated = 0;
      let deleted = 0;

      for (const docPath of toCreate) {
        const rel = docPath.replace(pathPrefixFlag ? `${pathPrefixFlag.replace(/\/$/, '')}/` : '/', '');
        const filePath = joinPath(resolvedSource, rel);
        const content = readFileSync(filePath, 'utf-8');
        await requestJson(context, `/orgs/${orgId}/docs`, {
          method: 'POST', body: { path: docPath, content },
        });
        created++;
      }

      for (const docPath of toUpdate) {
        const rel = docPath.replace(pathPrefixFlag ? `${pathPrefixFlag.replace(/\/$/, '')}/` : '/', '');
        const filePath = joinPath(resolvedSource, rel);
        const content = readFileSync(filePath, 'utf-8');
        await requestJson(context, `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`, {
          method: 'PUT', body: { content },
        });
        updated++;
      }

      for (const docPath of toDeletePaths) {
        await requestJson(context, `/orgs/${orgId}/docs/by-path?path=${encodeURIComponent(docPath)}`, {
          method: 'DELETE',
        });
        deleted++;
      }

      if (json) {
        console.log(JSON.stringify({ created, updated, deleted }));
      } else {
        console.log(`sync: ${created} created, ${updated} updated, ${deleted} deleted`);
      }
      return;
    }

    // ------------------------------------------------------------------
    // Watch (Enhancement 7)
    // ------------------------------------------------------------------

    case 'watch': {
      const pathPrefixFilter = getStringFlag(flags, ['path']);
      const sinceRaw = getStringFlag(flags, ['since']) ?? 'now';
      const projectId = getStringFlag(flags, ['project', 'project-id', 'project_id']);

      // Resolve the project to query events from.
      // Doc events go to the oldest project in the org (via findFirstByOrg in the API).
      // The projects list endpoint returns newest first, so we fetch more and pick the oldest.
      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const projects = await requestJson<{ data: { id: string; created_at: string }[] }>(
          context, `/projects?org_id=${encodeURIComponent(orgId)}&limit=100`,
        );
        if (!projects.data?.length) {
          throw new Error('No projects found in org. Watch requires at least one project for event polling.');
        }
        // Pick the oldest project (matches findFirstByOrg behavior)
        const sorted = [...projects.data].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        resolvedProjectId = sorted[0].id;
      }

      let since: string;
      if (sinceRaw === 'now') {
        since = new Date().toISOString();
      } else {
        // Parse as duration
        const match = sinceRaw.match(/^(\d+)([smhd])$/i);
        if (match) {
          const value = Number.parseInt(match[1], 10);
          const unit = match[2].toLowerCase();
          const ms = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
          since = new Date(Date.now() - value * ms).toISOString();
        } else {
          since = sinceRaw;
        }
      }

      const seen = new Set<string>();
      const DOC_EVENT_TYPES = new Set(['system.doc.created', 'system.doc.updated', 'system.doc.deleted']);
      const POLL_MS = 2000;

      // Stream loop
      const poll = async () => {
        try {
          const result = await requestJson<{
            data: Array<{
              id: string;
              type: string;
              payload_json?: {
                path?: string;
                version?: number;
                content_hash?: string;
                [key: string]: unknown;
              };
              created_at: string;
              [key: string]: unknown;
            }>;
          }>(context, `/projects/${resolvedProjectId}/events?since=${encodeURIComponent(since)}&limit=100`);

          for (const event of result.data ?? []) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);

            if (!DOC_EVENT_TYPES.has(event.type)) continue;
            const eventPath = event.payload_json?.path;
            if (pathPrefixFilter && eventPath && !eventPath.startsWith(pathPrefixFilter)) continue;

            const output = {
              type: event.type,
              path: eventPath,
              version: event.payload_json?.version ?? null,
              updated_at: event.created_at,
              content_hash: event.payload_json?.content_hash ?? null,
            };
            console.log(JSON.stringify(output));
          }

          // Advance since to latest event time
          if (result.data?.length) {
            const last = result.data[result.data.length - 1];
            since = last.created_at;
          }
        } catch {
          // Connection errors are transient — keep polling
        }
      };

      // Initial poll + periodic
      await poll();
      const timer = setInterval(() => void poll(), POLL_MS);
      // Keep process alive until killed
      process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
      process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
      // Block forever
      await new Promise(() => {});
      return;
    }

    default:
      throw new Error(
        'Usage: eve docs <command>\n\n' +
        'Commands:\n' +
        '  write/create --org <org> --path <path> --file <file>|--stdin\n' +
        '  read      --org <org> --path <path> [--version N]\n' +
        '  show      --org <org> --path <path> [--verbose]\n' +
        '  list      --org <org> [--path <prefix>] [--tree] [--json]\n' +
        '  search    --org <org> --query <text> [--path <prefix>] [--context N] [--mode text|semantic|hybrid]\n' +
        '  patch     --org <org> --path <path> --replace "old" "new" | --append "text" | --insert-after "anchor" "text"\n' +
        '  diff      --org <org> --path <path> [--from N] [--to N] [--unified]\n' +
        '  stale     --org <org> [--overdue-by 7d] [--prefix /agents/]\n' +
        '  review    --org <org> --path <path> --next-review 30d\n' +
        '  versions  --org <org> --path <path>\n' +
        '  query     --org <org> [--path-prefix <prefix>] --where "metadata.foo eq bar"\n' +
        '  delete    --org <org> --path <path>\n' +
        '  write-dir --org <org> --source <dir> [--path-prefix <prefix>]\n' +
        '  bulk-write --org <org> < docs.ndjson\n' +
        '  sync      --org <org> --source <dir> --path-prefix <prefix> [--dry-run] [--delete]\n' +
        '  watch     --org <org> [--path <prefix>] [--since now|5m|<iso>]',
      );
  }
}

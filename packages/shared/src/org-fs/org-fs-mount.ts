import * as fs from 'fs/promises';
import * as path from 'path';

export type OrgFsMountMode = 'none' | 'read' | 'write';

export type OrgFsMountSpec = {
  mode: OrgFsMountMode;
  allow_prefixes: string[];
  read_only_prefixes: string[];
};

const EMPTY_SPEC: OrgFsMountSpec = {
  mode: 'none',
  allow_prefixes: [],
  read_only_prefixes: [],
};

function normalizePrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const wildcard = trimmed.endsWith('/**');
  const rawBase = wildcard ? trimmed.slice(0, -3) : trimmed;
  if (rawBase.split('/').some((segment) => segment === '..')) {
    return null;
  }
  const normalizedBase = path.posix.normalize(rawBase.startsWith('/') ? rawBase : `/${rawBase}`);
  if (normalizedBase.split('/').some((segment) => segment === '..')) {
    return null;
  }

  if (wildcard) {
    return normalizedBase === '/' ? '/**' : `${normalizedBase.replace(/\/+$/, '')}/**`;
  }
  return normalizedBase || '/';
}

function normalizePrefixList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = normalizePrefix(item);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out].sort();
}

export function scopePrefixBasePath(prefix: string): string {
  if (prefix === '/**') {
    return '/';
  }
  if (prefix.endsWith('/**')) {
    const base = prefix.slice(0, -3).replace(/\/+$/, '');
    return base || '/';
  }
  return prefix;
}

export function matchesPrefix(pathValue: string, prefix: string): boolean {
  if (prefix === '/**') {
    return true;
  }
  const base = scopePrefixBasePath(prefix);
  return pathValue === base || pathValue.startsWith(`${base}/`);
}

function intersectsPrefix(a: string, b: string): boolean {
  return matchesPrefix(scopePrefixBasePath(a), b) || matchesPrefix(scopePrefixBasePath(b), a);
}

export function normalizeOrgFsMountSpec(rawSpec: unknown): OrgFsMountSpec {
  if (!rawSpec || typeof rawSpec !== 'object') {
    return EMPTY_SPEC;
  }

  const raw = rawSpec as {
    mode?: unknown;
    allow_prefixes?: unknown;
    read_only_prefixes?: unknown;
  };

  const mode = raw.mode === 'read' || raw.mode === 'write' ? raw.mode : 'none';
  const allow = normalizePrefixList(raw.allow_prefixes);
  if (mode === 'none' || allow.length === 0) {
    return EMPTY_SPEC;
  }

  const readOnly = normalizePrefixList(raw.read_only_prefixes).filter((prefix) =>
    allow.some((allowPrefix) => intersectsPrefix(prefix, allowPrefix)));

  return {
    mode,
    allow_prefixes: allow,
    read_only_prefixes: readOnly,
  };
}

function makePathReadOnly(statMode: number, isDir: boolean): number {
  return isDir ? statMode & ~0o222 : statMode & ~0o222;
}

async function chmodTreeReadOnly(targetPath: string): Promise<void> {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      await chmodTreeReadOnly(path.join(targetPath, entry.name));
    }
  }

  await fs.chmod(targetPath, makePathReadOnly(stat.mode, stat.isDirectory()));
}

async function copyReadOnly(sourcePath: string, targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
  await chmodTreeReadOnly(targetPath);
}

async function symlinkWritable(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await fs.stat(sourcePath);
  const linkType = sourceStat.isDirectory() ? 'dir' : 'file';
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.symlink(sourcePath, targetPath, linkType);
}

function resolveScopedPath(orgRoot: string, basePath: string): string | null {
  if (basePath === '/') {
    return orgRoot;
  }

  const relativePath = basePath.slice(1);
  const resolved = path.resolve(orgRoot, relativePath);
  const relative = path.relative(orgRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function prefixMode(spec: OrgFsMountSpec, prefix: string): 'read' | 'write' {
  if (spec.mode === 'read') {
    return 'read';
  }

  const basePath = scopePrefixBasePath(prefix);
  if (spec.read_only_prefixes.some((candidate) => matchesPrefix(basePath, candidate))) {
    return 'read';
  }

  return 'write';
}

export async function materializeScopedOrgFsMount(params: {
  workspacePath: string;
  orgRoot: string;
  rawSpec: unknown;
}): Promise<{ mountPath: string | null; spec: OrgFsMountSpec }> {
  const spec = normalizeOrgFsMountSpec(params.rawSpec);
  const target = path.join(params.workspacePath, '.org');

  await fs.mkdir(params.workspacePath, { recursive: true });
  await fs.rm(target, { recursive: true, force: true });

  if (spec.mode === 'none') {
    return { mountPath: null, spec };
  }

  try {
    const rootStat = await fs.stat(params.orgRoot);
    if (!rootStat.isDirectory()) {
      return { mountPath: null, spec: EMPTY_SPEC };
    }
  } catch {
    return { mountPath: null, spec: EMPTY_SPEC };
  }

  // Full mount is only safe when the scope is unconstrained and writable.
  if (
    spec.allow_prefixes.length === 1 &&
    spec.allow_prefixes[0] === '/**' &&
    spec.mode === 'write' &&
    spec.read_only_prefixes.length === 0
  ) {
    await fs.symlink(params.orgRoot, target, 'dir');
    return { mountPath: target, spec };
  }

  let mountedEntries = 0;
  await fs.mkdir(target, { recursive: true });

  const orderedPrefixes = [...spec.allow_prefixes].sort((a, b) => a.length - b.length);
  for (const prefix of orderedPrefixes) {
    const basePath = scopePrefixBasePath(prefix);
    const sourcePath = resolveScopedPath(params.orgRoot, basePath);
    if (!sourcePath) {
      continue;
    }

    try {
      await fs.stat(sourcePath);
    } catch {
      continue;
    }

    if (basePath === '/') {
      if (spec.mode === 'write' && spec.read_only_prefixes.length > 0) {
        await copyReadOnly(sourcePath, target);
      } else if (prefixMode(spec, prefix) === 'read') {
        await copyReadOnly(sourcePath, target);
      } else {
        await fs.rm(target, { recursive: true, force: true });
        await fs.symlink(sourcePath, target, 'dir');
      }
      mountedEntries += 1;
      break;
    }

    const relative = basePath.slice(1);
    const targetPath = path.join(target, relative);
    if (prefixMode(spec, prefix) === 'read') {
      await copyReadOnly(sourcePath, targetPath);
    } else {
      await symlinkWritable(sourcePath, targetPath);
    }
    mountedEntries += 1;
  }

  if (mountedEntries === 0) {
    await fs.rm(target, { recursive: true, force: true });
    return { mountPath: null, spec: EMPTY_SPEC };
  }

  return { mountPath: target, spec };
}

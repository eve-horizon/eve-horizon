import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';
import {
  MATERIALIZED_SKILLS_DIR,
  type MaterializedSkillsIndex,
  type ResolvedSkillSource,
  type SkillInstallMode,
  UNIVERSAL_SKILLS_DIR,
  readMaterializedSkillsIndex,
} from './discovery.js';

const EXCLUDE_FILES = new Set(['README.md', 'metadata.json']);
const EXCLUDE_DIRS = new Set(['.git']);

const AGENT_LAYOUTS: Record<
  string,
  | { type: 'universal' }
  | { type: 'shared-dir'; dir: string }
  | { type: 'per-skill'; dir: string }
> = {
  'claude-code': { type: 'shared-dir', dir: path.join('.claude', 'skills') },
  codex: { type: 'universal' },
  'gemini-cli': { type: 'universal' },
  pi: { type: 'per-skill', dir: path.join('.pi', 'skills') },
};

export interface PrepareSkillSourcesOptions {
  runtimeOnly?: boolean;
  vendorExternalSources?: boolean;
}

export interface MaterializeSkillSourcesOptions {
  mode?: SkillInstallMode;
}

export interface MaterializeSkillSourcesResult {
  materialized: Array<{ installName: string; targetPath: string; source: string }>;
  warnings: string[];
}

export async function prepareSkillSourcesForWorkspace(
  projectRoot: string,
  sources: ResolvedSkillSource[],
  opts: PrepareSkillSourcesOptions = {},
): Promise<ResolvedSkillSource[]> {
  if (opts.runtimeOnly) {
    return hydrateVendoredRemoteSources(projectRoot, sources);
  }

  if (opts.vendorExternalSources) {
    return vendorRemoteSources(projectRoot, sources);
  }

  return sources;
}

export async function materializeResolvedSkillSources(
  projectRoot: string,
  sources: ResolvedSkillSource[],
  opts: MaterializeSkillSourcesOptions = {},
): Promise<MaterializeSkillSourcesResult> {
  const mode = opts.mode ?? 'symlink';
  const canonicalDir = path.join(projectRoot, UNIVERSAL_SKILLS_DIR);
  const warnings: string[] = [];
  const materialized: Array<{ installName: string; targetPath: string; source: string }> = [];
  const collisions = new Map<string, string>();

  await fs.mkdir(canonicalDir, { recursive: true });

  for (const source of sources) {
    for (const skill of source.skills) {
      const existing = collisions.get(skill.installName);
      if (existing && existing !== source.source) {
        warnings.push(
          `[skills] Collision on "${skill.installName}": later source ${source.source} overrides ${existing}`,
        );
      }
      collisions.set(skill.installName, source.source);

      const destPath = path.join(canonicalDir, skill.installName);
      await removePath(destPath);
      await linkOrCopyDirectory(skill.skillPath, destPath, mode);
      materialized.push({
        installName: skill.installName,
        targetPath: destPath,
        source: source.source,
      });
    }
  }

  const installAgents = new Set<string>();
  for (const source of sources) {
    for (const agent of source.installAgents) {
      installAgents.add(agent);
    }
  }

  await ensureAgentBridges(projectRoot, Array.from(installAgents), materialized, mode);

  for (const warning of warnings) {
    console.warn(warning);
  }

  return { materialized, warnings };
}

async function hydrateVendoredRemoteSources(
  projectRoot: string,
  sources: ResolvedSkillSource[],
): Promise<ResolvedSkillSource[]> {
  const index = readMaterializedSkillsIndex(projectRoot);
  return sources.map((source) => {
    if (source.sourceType !== 'remote') {
      return source;
    }

    const match = index.sources.find(
      (entry) => entry.id === source.id && entry.source === source.source && entry.ref === source.ref,
    );
    if (!match) {
      throw new Error(
        `Missing vendored runtime skills for ${source.source}@${source.ref ?? 'local'} in ${path.join(projectRoot, MATERIALIZED_SKILLS_DIR)}. Run "eve skills materialize manifest" first.`,
      );
    }

    return {
      ...source,
      sourceType: 'vendored',
      resolvedRoot: path.join(projectRoot, MATERIALIZED_SKILLS_DIR),
      skills: match.skills.map((skill) => ({
        ...findSourceSkill(source, skill.install_name),
        installName: skill.install_name,
        skillPath: path.join(projectRoot, MATERIALIZED_SKILLS_DIR, skill.materialized_path),
      })),
    };
  });
}

async function vendorRemoteSources(
  projectRoot: string,
  sources: ResolvedSkillSource[],
): Promise<ResolvedSkillSource[]> {
  const sidecarRoot = path.join(projectRoot, MATERIALIZED_SKILLS_DIR);
  const remoteSources = sources.filter((source) => source.sourceType === 'remote');

  await fs.mkdir(sidecarRoot, { recursive: true });

  const activeSourceIds = new Set(remoteSources.map((source) => source.id));
  const existingEntries = await fs.readdir(sidecarRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    existingEntries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      if (!activeSourceIds.has(entry.name)) {
        await fs.rm(path.join(sidecarRoot, entry.name), { recursive: true, force: true });
      }
    }),
  );

  const index: MaterializedSkillsIndex = { version: 1, sources: [] };
  const updated = new Map<string, ResolvedSkillSource>();

  for (const source of remoteSources) {
    const sourceDir = path.join(sidecarRoot, source.id);
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const indexSkills = [];
    const vendoredSkills = [];

    for (const skill of source.skills) {
      const dest = path.join(sourceDir, skill.installName);
      await copyDirectoryFiltered(skill.skillPath, dest);
      const contentHash = await hashDirectory(dest);
      const materializedPath = path.join(source.id, skill.installName);

      indexSkills.push({
        install_name: skill.installName,
        source_path: path.relative(source.resolvedRoot, skill.skillPath),
        content_hash: contentHash,
        materialized_path: materializedPath,
      });

      vendoredSkills.push({
        ...skill,
        skillPath: dest,
      });
    }

    index.sources.push({
      id: source.id,
      source: source.source,
      ref: source.ref,
      origin: 'manifest-pack',
      source_type: 'remote',
      skills: indexSkills,
    });

    updated.set(source.id, {
      ...source,
      sourceType: 'vendored',
      resolvedRoot: sourceDir,
      skills: vendoredSkills,
    });
  }

  await fs.writeFile(path.join(sidecarRoot, 'index.yaml'), stringifyYaml(index), 'utf-8');

  return sources.map((source) => updated.get(source.id) ?? source);
}

async function ensureAgentBridges(
  projectRoot: string,
  installAgents: string[],
  materialized: Array<{ installName: string; targetPath: string; source: string }>,
  mode: SkillInstallMode,
): Promise<void> {
  const canonicalDir = path.join(projectRoot, UNIVERSAL_SKILLS_DIR);

  for (const agent of installAgents) {
    const layout = AGENT_LAYOUTS[agent];
    if (!layout || layout.type === 'universal') continue;

    if (layout.type === 'shared-dir') {
      await ensureSharedDirBridge(projectRoot, canonicalDir, layout.dir, mode);
      continue;
    }

    await ensurePerSkillBridge(projectRoot, layout.dir, materialized, mode);
  }
}

async function ensureSharedDirBridge(
  projectRoot: string,
  canonicalDir: string,
  bridgeDir: string,
  mode: SkillInstallMode,
): Promise<void> {
  const absoluteBridgeDir = path.join(projectRoot, bridgeDir);
  await fs.mkdir(path.dirname(absoluteBridgeDir), { recursive: true });

  try {
    const stat = await fs.lstat(absoluteBridgeDir);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absoluteBridgeDir);
      if (
        target === path.relative(path.dirname(absoluteBridgeDir), canonicalDir) ||
        path.resolve(path.dirname(absoluteBridgeDir), target) === canonicalDir
      ) {
        return;
      }
      await fs.unlink(absoluteBridgeDir);
    } else if (stat.isDirectory()) {
      const entries = await fs.readdir(canonicalDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const sourcePath = path.join(canonicalDir, entry.name);
        const destPath = path.join(absoluteBridgeDir, entry.name);
        if (fsSync.existsSync(destPath)) continue;
        await linkOrCopyDirectory(sourcePath, destPath, mode);
      }
      return;
    } else {
      await removePath(absoluteBridgeDir);
    }
  } catch {
    // Path does not exist yet.
  }

  if (mode === 'symlink') {
    const relativeTarget = path.relative(path.dirname(absoluteBridgeDir), canonicalDir);
    try {
      await fs.symlink(relativeTarget, absoluteBridgeDir, 'dir');
      return;
    } catch {
      // Fall back to overlay directory below.
    }
  }

  await fs.mkdir(absoluteBridgeDir, { recursive: true });
  const entries = await fs.readdir(canonicalDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    await linkOrCopyDirectory(
      path.join(canonicalDir, entry.name),
      path.join(absoluteBridgeDir, entry.name),
      mode,
    );
  }
}

async function ensurePerSkillBridge(
  projectRoot: string,
  bridgeDir: string,
  materialized: Array<{ installName: string; targetPath: string; source: string }>,
  mode: SkillInstallMode,
): Promise<void> {
  const absoluteBridgeDir = path.join(projectRoot, bridgeDir);
  await fs.mkdir(absoluteBridgeDir, { recursive: true });

  for (const skill of materialized) {
    const destPath = path.join(absoluteBridgeDir, skill.installName);
    await removePath(destPath);
    await linkOrCopyDirectory(skill.targetPath, destPath, mode);
  }
}

async function linkOrCopyDirectory(
  sourcePath: string,
  destPath: string,
  mode: SkillInstallMode,
): Promise<void> {
  if (mode === 'symlink') {
    const relativeTarget = path.relative(path.dirname(destPath), sourcePath);
    try {
      await fs.symlink(relativeTarget, destPath, 'dir');
      return;
    } catch {
      // Fall back to copy.
    }
  }

  await copyDirectoryFiltered(sourcePath, destPath);
}

async function copyDirectoryFiltered(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => !isExcluded(entry.name, entry.isDirectory()))
      .map(async (entry) => {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          await copyDirectoryFiltered(srcPath, destPath);
          return;
        }
        await fs.cp(srcPath, destPath, { dereference: true, recursive: true });
      }),
  );
}

function isExcluded(name: string, isDirectory = false): boolean {
  if (EXCLUDE_FILES.has(name)) return true;
  if (name.startsWith('_')) return true;
  if (isDirectory && EXCLUDE_DIRS.has(name)) return true;
  return false;
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function hashDirectory(rootDir: string): Promise<string> {
  const files = await collectFiles(rootDir);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(rootDir, file));
    hash.update('\0');
    hash.update(await fs.readFile(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(fullPath)));
      continue;
    }
    out.push(fullPath);
  }
  out.sort();
  return out;
}

function findSourceSkill(source: ResolvedSkillSource, installName: string) {
  const skill = source.skills.find((entry) => entry.installName === installName);
  if (!skill) {
    throw new Error(`Vendored skills index references unknown skill "${installName}" for ${source.source}`);
  }
  return skill;
}

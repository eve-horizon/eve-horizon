import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { resolvePack } from '../lib/pack-resolver.js';
import {
  ManifestSchema,
  type Manifest,
  type PackEntry,
  type ResolvedPack,
} from '../schemas/index.js';

export const UNIVERSAL_SKILLS_DIR = path.join('.agents', 'skills');
export const MATERIALIZED_SKILLS_DIR = path.join('.eve', 'materialized-skills');
export const PRIVATE_SKILLS_DIRNAME = 'private-skills';
export const DEFAULT_SKILL_AGENTS = ['claude-code', 'codex', 'gemini-cli', 'pi'] as const;

export type SupportedSkillAgent = (typeof DEFAULT_SKILL_AGENTS)[number];
export type SkillInstallMode = 'symlink' | 'copy';

export interface SkillSource {
  raw: string;
  source: string;
  type: 'local' | 'github' | 'url';
  name: string;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  installName: string;
  skillPath: string;
}

export interface ResolvedSkillSource {
  id: string;
  source: string;
  ref?: string;
  origin: 'manifest-pack' | 'skills-txt';
  sourceType: 'local' | 'remote' | 'vendored';
  resolvedRoot: string;
  installAgents: string[];
  skills: DiscoveredSkill[];
}

export interface ResolvedSkillMode {
  name: string;
  includeManifestPacks: boolean;
  includeSkillsTxt: boolean;
  extraPacks: PackEntry[];
  packs: PackEntry[];
  installAgents: string[];
}

export interface ResolveManifestSkillSourcesOptions {
  modeName?: string;
  runtimeOnly?: boolean;
}

export interface MaterializedSkillIndexEntry {
  install_name: string;
  source_path: string;
  content_hash: string;
  materialized_path: string;
}

export interface MaterializedSkillIndexSource {
  id: string;
  source: string;
  ref?: string;
  origin: 'manifest-pack';
  source_type: 'remote';
  skills: MaterializedSkillIndexEntry[];
}

export interface MaterializedSkillsIndex {
  version: 1;
  sources: MaterializedSkillIndexSource[];
}

type ManifestSkillModeConfig = {
  pack_set?: 'runtime';
  packs?: 'runtime' | PackEntry[];
  include_skills_txt?: boolean;
  extra_packs?: PackEntry[];
  install_agents?: string[];
};

export function sanitizeSkillName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .substring(0, 255) || 'unnamed-skill'
  );
}

export function buildSkillSourceId(source: string, ref?: string): string {
  const basename = sanitizeSkillName(path.basename(source).replace(/\.git$/, '')) || 'skills';
  const digest = createHash('sha256')
    .update(`${source}@${ref ?? 'local'}`)
    .digest('hex')
    .slice(0, 12);
  return `${basename}-${digest}`;
}

export function parseSkillSource(line: string): SkillSource {
  if (line.startsWith('https://') || line.startsWith('http://')) {
    const name = extractNameFromUrl(line);
    return { raw: line, source: line, type: 'url', name };
  }

  if (line.startsWith('github:')) {
    const repo = line.slice(7);
    const name = extractNameFromRepo(repo);
    return { raw: line, source: line, type: 'github', name };
  }

  if (line.startsWith('/') || line.startsWith('~')) {
    return { raw: line, source: line, type: 'local', name: path.basename(line) };
  }

  if (line.startsWith('./') || line.startsWith('../')) {
    return { raw: line, source: line, type: 'local', name: path.basename(line) };
  }

  if (fs.existsSync(line)) {
    return { raw: line, source: `./${line}`, type: 'local', name: path.basename(line) };
  }

  if (line.includes('/') && !line.includes(' ')) {
    const name = extractNameFromRepo(line);
    return { raw: line, source: line, type: 'github', name };
  }

  return { raw: line, source: `./${line}`, type: 'local', name: path.basename(line) };
}

export function parseSkillsManifest(manifestPath: string): SkillSource[] {
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  const content = fs.readFileSync(manifestPath, 'utf-8');
  const sources: SkillSource[] = [];
  const manifestDir = path.dirname(manifestPath);

  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    if (isGlobPattern(line)) {
      const explicitPrivateTarget = sourcePathExplicitlyTargetsPrivate(line);
      const expanded = expandGlobPattern(line, manifestPath, explicitPrivateTarget);
      sources.push(...expanded);
      continue;
    }

    const parsed = parseSkillSource(line);
    if (parsed.type === 'local') {
      const expanded = tryExpandLocalDirectory(parsed, manifestDir);
      if (expanded) {
        sources.push(...expanded);
        continue;
      }
    }

    sources.push(parsed);
  }

  return sources;
}

export function findSkillDirs(
  rootDir: string,
  opts: { fullDepth: boolean; excludePrivate: boolean },
): string[] {
  const out: string[] = [];

  const shouldSkipDir = (_parentAbsDir: string, name: string): boolean => {
    if (name.startsWith('.')) return true;
    if (name === 'node_modules' || name === '.git') return true;
    if (opts.excludePrivate && name === PRIVATE_SKILLS_DIRNAME) return true;
    if (name === '.agents' || name === '.agent' || name === '.claude') return true;
    return false;
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasSkillMd = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md');
    if (hasSkillMd) {
      out.push(dir);
      if (!opts.fullDepth) return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDir(dir, entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };

  walk(rootDir);
  return out;
}

export function discoverSkillDefinition(skillDir: string): DiscoveredSkill {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillMdPath, 'utf-8');
  const frontmatter = parseSkillFrontmatter(raw, skillMdPath);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

  if (!name || !description) {
    throw new Error(`Invalid SKILL.md at ${skillMdPath}: required frontmatter fields "name" and "description"`);
  }

  return {
    name,
    description,
    installName: sanitizeSkillName(name),
    skillPath: skillDir,
  };
}

export function discoverSkillDefinitions(skillDirs: string[]): DiscoveredSkill[] {
  return skillDirs.map((skillDir) => discoverSkillDefinition(skillDir));
}

export function readMaterializedSkillsIndex(projectRoot: string): MaterializedSkillsIndex {
  const indexPath = path.join(projectRoot, MATERIALIZED_SKILLS_DIR, 'index.yaml');
  if (!fs.existsSync(indexPath)) {
    return { version: 1, sources: [] };
  }

  const parsed = parseYaml(fs.readFileSync(indexPath, 'utf-8')) as
    | MaterializedSkillsIndex
    | null
    | undefined;

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) {
    throw new Error(`Invalid materialized skills index at ${indexPath}`);
  }

  return {
    version: 1,
    sources: parsed.sources,
  };
}

export function readProjectManifest(
  projectRoot: string,
  opts: { optional?: boolean } = {},
): Manifest | null {
  const manifestPath = path.join(projectRoot, '.eve', 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    if (opts.optional) return null;
    throw new Error(`No manifest found at ${manifestPath}`);
  }

  const parsed = parseYaml(fs.readFileSync(manifestPath, 'utf-8')) ?? {};
  return ManifestSchema.parse(parsed);
}

export function resolveManifestSkillMode(
  manifest: Manifest,
  modeName = 'runtime',
): ResolvedSkillMode {
  const xEve = getManifestXEve(manifest);
  const topLevelPacks = Array.isArray(xEve?.packs) ? (xEve.packs as PackEntry[]) : [];
  const defaultInstallAgents = normalizeInstallAgents(
    Array.isArray(xEve?.install_agents) ? xEve.install_agents : undefined,
  );
  const skillModes =
    xEve && typeof xEve.skill_modes === 'object' && xEve.skill_modes
      ? (xEve.skill_modes as Record<string, ManifestSkillModeConfig>)
      : {};

  if (!skillModes[modeName]) {
    if (modeName === 'runtime') {
      return {
        name: modeName,
        includeManifestPacks: true,
        includeSkillsTxt: false,
        extraPacks: [],
        packs: topLevelPacks,
        installAgents: defaultInstallAgents,
      };
    }

    if (modeName === 'software-engineering') {
      return {
        name: modeName,
        includeManifestPacks: true,
        includeSkillsTxt: true,
        extraPacks: [],
        packs: topLevelPacks,
        installAgents: defaultInstallAgents,
      };
    }

    throw new Error(`Unknown skill mode "${modeName}" in manifest`);
  }

  const mode = skillModes[modeName] ?? {};
  const includeManifestPacks =
    mode.pack_set === 'runtime' ||
    mode.packs === 'runtime' ||
    (mode.pack_set === undefined && mode.packs === undefined);
  const explicitPacks = Array.isArray(mode.packs) ? mode.packs : [];
  const extraPacks = Array.isArray(mode.extra_packs) ? mode.extra_packs : [];

  return {
    name: modeName,
    includeManifestPacks,
    includeSkillsTxt: Boolean(mode.include_skills_txt),
    extraPacks,
    packs: [
      ...(includeManifestPacks ? topLevelPacks : []),
      ...explicitPacks,
      ...extraPacks,
    ],
    installAgents: normalizeInstallAgents(mode.install_agents ?? defaultInstallAgents),
  };
}

export async function resolveManifestSkillSources(
  projectRoot: string,
  opts: ResolveManifestSkillSourcesOptions = {},
): Promise<{ manifest: Manifest | null; mode: ResolvedSkillMode | null; sources: ResolvedSkillSource[] }> {
  const manifest = readProjectManifest(projectRoot, { optional: true });
  if (!manifest) {
    return { manifest: null, mode: null, sources: [] };
  }

  const mode = resolveManifestSkillMode(manifest, opts.modeName ?? 'runtime');
  const sources: ResolvedSkillSource[] = [];

  const hasRemotePack = mode.packs.some((pack) => isRemotePackSource(pack.source));
  if (hasRemotePack) {
    validateManifestPackLockfile(projectRoot, mode.packs);
  }

  const projectSlug = readProjectSlug(manifest, projectRoot);
  for (const pack of mode.packs) {
    const resolved = await resolvePack(pack, projectSlug, projectRoot);
    sources.push(buildResolvedPackSkillSource(resolved, pack, mode.installAgents));
  }

  if (mode.includeSkillsTxt) {
    const skillsTxtSources = resolveSkillsTxtSkillSources(projectRoot, {
      installAgents: mode.installAgents,
      localOnly: opts.runtimeOnly !== false,
    });
    sources.push(...skillsTxtSources);
  }

  return { manifest, mode, sources };
}

export function resolveSkillsTxtSkillSources(
  projectRoot: string,
  opts: { installAgents?: string[]; localOnly?: boolean } = {},
): ResolvedSkillSource[] {
  const manifestPath = path.join(projectRoot, 'skills.txt');
  const parsed = parseSkillsManifest(manifestPath);
  const installAgents = normalizeInstallAgents(opts.installAgents);
  const out: ResolvedSkillSource[] = [];

  for (const source of parsed) {
    if (source.type !== 'local') {
      if (opts.localOnly !== false) {
        console.warn(
          `[skills] Skipping non-local skills.txt source in fast path: ${source.source}. Use "eve skills install" for remote developer installs.`,
        );
        continue;
      }

      throw new Error(
        `Fast-path materialization only supports local skills.txt sources. Unsupported source: ${source.source}`,
      );
    }

    const skillDir = resolveLocalSkillDir(source, projectRoot);
    if (!skillDir) {
      console.warn(`[skills] Skipping missing local skill source: ${source.source}`);
      continue;
    }

    const skill = discoverSkillDefinition(skillDir);
    out.push({
      id: buildSkillSourceId(source.source),
      source: source.source,
      origin: 'skills-txt',
      sourceType: 'local',
      resolvedRoot: skillDir,
      installAgents,
      skills: [skill],
    });
  }

  return out;
}

function buildResolvedPackSkillSource(
  resolved: ResolvedPack,
  entry: PackEntry,
  fallbackInstallAgents: string[],
): ResolvedSkillSource {
  return {
    id: buildSkillSourceId(entry.source, resolved.ref),
    source: entry.source,
    ref: resolved.ref,
    origin: 'manifest-pack',
    sourceType: isRemotePackSource(entry.source) ? 'remote' : 'local',
    resolvedRoot: resolved.rootPath,
    installAgents: normalizeInstallAgents(entry.install_agents ?? fallbackInstallAgents),
    skills: discoverSkillDefinitions(resolved.skillPaths),
  };
}

function normalizeInstallAgents(agents?: string[]): string[] {
  const values = Array.isArray(agents) && agents.length > 0 ? agents : [...DEFAULT_SKILL_AGENTS];
  return Array.from(new Set(values));
}

function parseSkillFrontmatter(content: string, skillMdPath: string): Record<string, unknown> {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`Invalid SKILL.md at ${skillMdPath}: expected YAML frontmatter`);
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    throw new Error(`Invalid SKILL.md at ${skillMdPath}: missing closing frontmatter delimiter`);
  }

  const block = normalized.slice(4, closingIndex);
  const parsed = parseYaml(block);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid SKILL.md at ${skillMdPath}: frontmatter must be a YAML object`);
  }

  return parsed as Record<string, unknown>;
}

function resolveLocalSkillDir(skill: SkillSource, projectRoot: string): string | null {
  let source = skill.source;
  if (source.startsWith('~')) {
    source = source.replace(/^~/, process.env.HOME || '~');
  }

  const abs = path.isAbsolute(source) ? source : path.resolve(projectRoot, source);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
    if (fs.existsSync(path.join(abs, 'SKILL.md'))) return abs;

    const explicitPrivate = sourcePathExplicitlyTargetsPrivate(skill.source);
    const skillDirs = findSkillDirs(abs, { fullDepth: true, excludePrivate: !explicitPrivate });
    if (skillDirs.length === 1) return skillDirs[0];
    return null;
  } catch {
    return null;
  }
}

function isGlobPattern(line: string): boolean {
  return line.includes('*');
}

function expandGlobPattern(
  pattern: string,
  basePath: string,
  explicitPrivateTarget: boolean,
): SkillSource[] {
  const sources: SkillSource[] = [];
  const isRecursive = pattern.endsWith('/**');
  const basePattern = pattern.replace(/\/\*+$/, '');

  let searchRoot: string;
  if (basePattern.startsWith('./') || basePattern.startsWith('../')) {
    searchRoot = path.resolve(path.dirname(basePath), basePattern);
  } else if (basePattern.startsWith('/')) {
    searchRoot = basePattern;
  } else if (basePattern.startsWith('~')) {
    searchRoot = basePattern.replace(/^~/, process.env.HOME || '~');
  } else {
    searchRoot = path.resolve(path.dirname(basePath), basePattern);
  }

  if (!fs.existsSync(searchRoot)) {
    console.warn(`Warning: Glob pattern base directory not found: ${searchRoot}`);
    return sources;
  }

  const walk = (dir: string, depth: number): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (!explicitPrivateTarget && entry.name === PRIVATE_SKILLS_DIRNAME) continue;

        const fullPath = path.join(dir, entry.name);
        if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
          const relativePath = path.relative(path.dirname(basePath), fullPath);
          const source = relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
          if (!explicitPrivateTarget && pathContainsPrivateSkills(source)) continue;

          sources.push({
            raw: pattern,
            source,
            type: 'local',
            name: entry.name,
          });
        }

        if (isRecursive || depth === 0) {
          walk(fullPath, depth + 1);
        }
      }
    } catch (err) {
      console.warn(`Warning: Error reading directory ${dir}:`, err);
    }
  };

  walk(searchRoot, 0);
  return sources;
}

function tryExpandLocalDirectory(skill: SkillSource, manifestDir: string): SkillSource[] | null {
  let source = skill.source;
  if (source.startsWith('~')) {
    source = source.replace(/^~/, process.env.HOME || '~');
  }

  const abs = path.isAbsolute(source) ? source : path.resolve(manifestDir, source);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }

  if (fs.existsSync(path.join(abs, 'SKILL.md'))) return null;

  const explicitPrivate = sourcePathExplicitlyTargetsPrivate(skill.source);
  const skillDirs = findSkillDirs(abs, { fullDepth: true, excludePrivate: !explicitPrivate });
  if (skillDirs.length === 0) return null;

  return skillDirs.map((dir) => {
    const relativePath = path.relative(manifestDir, dir);
    return {
      raw: skill.raw,
      source: relativePath.startsWith('.') ? relativePath : `./${relativePath}`,
      type: 'local' as const,
      name: path.basename(dir),
    };
  });
}

export function sourcePathExplicitlyTargetsPrivate(source: string): boolean {
  return pathContainsPrivateSkills(source);
}

function pathContainsPrivateSkills(source: string): boolean {
  const normalized = path.normalize(source).replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.includes(PRIVATE_SKILLS_DIRNAME);
}

function extractNameFromUrl(url: string): string {
  const match = url.match(/github\.com\/[^/]+\/([^/]+)/);
  if (match) {
    return match[1].replace(/\.git$/, '');
  }
  return path.basename(new URL(url).pathname).replace(/\.git$/, '');
}

function extractNameFromRepo(repo: string): string {
  const parts = repo.split('/');
  return parts[parts.length - 1].replace(/\.git$/, '');
}

function readProjectSlug(manifest: Manifest, projectRoot: string): string {
  const value =
    (typeof manifest.name === 'string' && manifest.name) ||
    (typeof manifest.project === 'string' && manifest.project) ||
    path.basename(projectRoot);
  return value.toLowerCase().replace(/_/g, '-');
}

function isRemotePackSource(source: string): boolean {
  return (
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    source.startsWith('git@') ||
    source.startsWith('github:') ||
    (!source.startsWith('./') &&
      !source.startsWith('../') &&
      !source.startsWith('/') &&
      source.includes('/'))
  );
}

function validateManifestPackLockfile(projectRoot: string, packs: PackEntry[]): void {
  const lockfilePath = path.join(projectRoot, '.eve', 'packs.lock.yaml');
  if (!fs.existsSync(lockfilePath)) {
    throw new Error('Packs defined in manifest but no .eve/packs.lock.yaml found. Run "eve project sync" first.');
  }

  const parsed = parseYaml(fs.readFileSync(lockfilePath, 'utf-8')) as
    | { packs?: Array<{ source: string; ref: string }> }
    | null
    | undefined;
  if (!parsed || !Array.isArray(parsed.packs)) {
    throw new Error('Failed to parse .eve/packs.lock.yaml. Run "eve project sync" first.');
  }

  for (const pack of packs) {
    if (!isRemotePackSource(pack.source)) continue;

    const locked = parsed.packs.find((entry) => entry.source === pack.source);
    if (!locked) {
      throw new Error(`Pack "${pack.source}" in manifest but not in lockfile. Run "eve project sync".`);
    }

    if (pack.ref && locked.ref !== pack.ref) {
      throw new Error(
        `Pack ref mismatch for "${pack.source}": manifest has ${pack.ref.slice(0, 8)}, lock has ${locked.ref.slice(0, 8)}. Run "eve project sync".`,
      );
    }
  }
}

function getManifestXEve(manifest: Manifest): Record<string, unknown> | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object') {
    return xEve as Record<string, unknown>;
  }
  return null;
}

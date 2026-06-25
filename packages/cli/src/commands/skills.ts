import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import * as yaml from 'yaml';
import {
  DEFAULT_SKILL_AGENTS,
  findSkillDirs,
  parseSkillSource,
  parseSkillsManifest,
  sourcePathExplicitlyTargetsPrivate,
  UNIVERSAL_SKILLS_DIR,
} from '@eve/shared';
import type { FlagValue } from '../lib/args';
import { runSkillsMaterialize } from '../lib/skills-materialize';

const PRIVATE_SKILLS_DIRNAME = 'private-skills';

// ============================================================================
// Types
// ============================================================================

interface SkillSource {
  raw: string;
  source: string;
  type: 'local' | 'github' | 'url';
  name: string;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleSkills(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
): Promise<void> {
  switch (subcommand) {
    case 'install':
      return handleInstall(positionals, flags);
    case 'materialize':
      return handleMaterialize(positionals, flags);

    default:
      throw new Error(
        'Usage: eve skills <subcommand> [source]\n' +
        '  install              Install skills from skills.txt using skills CLI\n' +
        '  install <source>     Install from URL, GitHub repo, or local path\n' +
        '  materialize          Fast filesystem-only skill materialization\n' +
        '\n' +
        'Sources:\n' +
        '  https://github.com/org/repo     GitHub URL\n' +
        '  org/repo                         GitHub shorthand\n' +
        '  ./local/path                     Local directory',
      );
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

/**
 * eve skills install [source] [--skip-installed]
 *
 * With source:  install directly from URL/repo/path (and persist to skills.txt)
 * Without:      install all entries from skills.txt
 */
async function handleInstall(positionals: string[], flags: Record<string, FlagValue>): Promise<void> {
  const skipInstalled = Boolean(flags['skip-installed']);
  const projectRoot = process.cwd();
  const skillsBin = resolveSkillsBinary();
  const manifestPath = path.join(projectRoot, 'skills.txt');
  const skillsDir = path.join(projectRoot, UNIVERSAL_SKILLS_DIR);

  // Direct source install: eve skills install <source>
  const source = positionals[0];
  if (source) {
    const parsed = parseSkillSource(source);
    console.log(`Installing skill pack: ${parsed.source} (${parsed.type})`);

    // Persist to skills.txt for future installs
    persistToManifest(manifestPath, source);

    // Install directly
    installSkill(skillsBin, parsed, projectRoot);
    ensureSkillsSymlink(projectRoot);
    console.log('Skills install complete');
    return;
  }

  // Install from packs (from .eve/manifest.yaml x-eve.packs)
  const packsInstalled = installPackSkills(skillsBin, projectRoot);

  // Also install from skills.txt (complementary to packs — handles additional
  // sources like external skillpacks and private-skills/ that packs exclude)
  const manifest = parseSkillsManifest(manifestPath);
  if (manifest.length > 0) {
    const toInstall = skipInstalled
      ? manifest.filter((s) => !getInstalledSkills(skillsDir).has(s.name))
      : manifest;

    if (toInstall.length > 0) {
      console.log(`Installing ${toInstall.length} skill(s) from skills.txt...`);
      for (const skill of toInstall) {
        installSkill(skillsBin, skill, projectRoot);
      }
    }
  }

  if (!packsInstalled && manifest.length === 0) {
    console.log('No packs or skills.txt found; nothing to install');
    console.log('Usage: eve skills install <source>');
    console.log('  e.g. eve skills install https://github.com/org/skillpack');
    return;
  }

  // Ensure .claude/skills symlink exists
  ensureSkillsSymlink(projectRoot);
  console.log('Skills install complete');
}

async function handleMaterialize(positionals: string[], flags: Record<string, FlagValue>): Promise<void> {
  await runSkillsMaterialize(process.cwd(), positionals, flags);
}

// ============================================================================
// Skill Installation
// ============================================================================

/**
 * Install a single skill source for all supported agents.
 */
function installSkill(skillsBin: string, skill: SkillSource, projectRoot: string): void {
  console.log(`  Installing: ${skill.source} (${skill.type})`);

  const localDir = resolveLocalDirIfExists(skill, projectRoot);
  const excludePrivate = localDir !== null && !sourcePathExplicitlyTargetsPrivate(skill.source);

  try {
    const agents = ['claude-code', 'codex', 'gemini-cli', 'pi'];

    // For local directories, enumerate skill subdirectories ourselves so we
    // install each one individually.  This avoids relying on the external
    // `skills` binary to recurse correctly and lets us skip private-skills/.
    if (localDir) {
      const skillDirs = findSkillDirs(localDir, { fullDepth: true, excludePrivate });
      if (skillDirs.length === 0) {
        console.log(`  No skills found under ${skill.source}`);
        return;
      }

      if (skillDirs.length > 1 || skillDirs[0] !== localDir) {
        const label = excludePrivate ? ` (excluding ${PRIVATE_SKILLS_DIRNAME}/)` : '';
        console.log(`  Installing ${skillDirs.length} skill(s)${label}...`);
        for (const dir of skillDirs) {
          const rel = path.relative(projectRoot, dir);
          const installSource = rel.startsWith('.') ? rel : `./${rel}`;
          for (const agent of agents) {
            execSync(`${skillsBin} add ${JSON.stringify(installSource)} -a ${agent} -s '*' -y --full-depth`, {
              cwd: projectRoot,
              stdio: 'inherit',
              timeout: 120000,
            });
          }
        }
        return;
      }
    }

    for (const agent of agents) {
      execSync(`${skillsBin} add ${JSON.stringify(skill.source)} -a ${agent} -s '*' -y --full-depth`, {
        cwd: projectRoot,
        stdio: 'inherit',
        timeout: 120000,
      });
    }
  } catch (err) {
    console.error(`  Failed to install ${skill.name}`);
  }
}

// ============================================================================
// Pack-based Installation
// ============================================================================

const DEFAULT_AGENTS = [...DEFAULT_SKILL_AGENTS];

/**
 * Install skills from packs defined in .eve/manifest.yaml x-eve.packs.
 * Returns true if packs were found and installed, false if no packs configured.
 */
function installPackSkills(skillsBin: string, projectRoot: string): boolean {
  const manifestPath = path.join(projectRoot, '.eve', 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) return false;

  let manifest: Record<string, unknown>;
  try {
    manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8')) ?? {};
  } catch {
    return false;
  }

  const xEve = (manifest['x-eve'] ?? manifest['x_eve']) as Record<string, unknown> | undefined;
  const packs = (xEve?.packs ?? []) as Array<{ source: string; ref?: string; install_agents?: string[] }>;
  if (packs.length === 0) return false;

  const installAgents = (xEve?.install_agents as string[] | undefined) ?? DEFAULT_AGENTS;

  // Verify lockfile
  const lockfilePath = path.join(projectRoot, '.eve', 'packs.lock.yaml');
  if (!fs.existsSync(lockfilePath)) {
    console.error('Warning: packs defined in manifest but no .eve/packs.lock.yaml found. Run "eve project sync" first.');
    return false;
  }

  let lockfile: { packs: Array<{ source: string; ref: string }> };
  try {
    lockfile = yaml.parse(fs.readFileSync(lockfilePath, 'utf-8'));
  } catch (err) {
    console.error('Warning: failed to parse .eve/packs.lock.yaml:', err);
    return false;
  }

  // Verify lock matches manifest
  for (const pack of packs) {
    if (!pack.ref) continue;
    const locked = lockfile.packs.find((p) => p.source === pack.source);
    if (!locked) {
      throw new Error(`Pack "${pack.source}" in manifest but not in lockfile. Run "eve project sync".`);
    }
    if (locked.ref !== pack.ref) {
      throw new Error(
        `Pack ref mismatch for "${pack.source}": manifest has ${pack.ref?.substring(0, 8)}, ` +
        `lock has ${locked.ref.substring(0, 8)}. Run "eve project sync".`,
      );
    }
  }

  console.log(`Installing skills from ${packs.length} pack(s) for ${installAgents.length} agent(s)...`);

  for (const pack of packs) {
    const agents = pack.install_agents ?? installAgents;
    console.log(`  Pack: ${pack.source}`);

    const localDir = resolveLocalDirIfExists({ source: pack.source, type: 'local', raw: pack.source, name: path.basename(pack.source) }, projectRoot);
    const wantsExcludePrivate =
      localDir !== null &&
      !sourcePathExplicitlyTargetsPrivate(pack.source);

    for (const agent of agents) {
      try {
        if (wantsExcludePrivate && localDir) {
          const skillDirs = findSkillDirs(localDir, { fullDepth: true, excludePrivate: true });
          for (const dir of skillDirs) {
            const rel = path.relative(projectRoot, dir);
            const installSource = rel.startsWith('.') ? rel : `./${rel}`;
            execSync(`${skillsBin} add ${JSON.stringify(installSource)} -a ${agent} -s '*' -y --full-depth`, {
              cwd: projectRoot,
              stdio: 'inherit',
              timeout: 120000,
            });
          }
        } else {
          execSync(`${skillsBin} add ${JSON.stringify(pack.source)} -a ${agent} -s '*' -y --full-depth`, {
            cwd: projectRoot,
            stdio: 'inherit',
            timeout: 120000,
          });
        }
      } catch (err) {
        console.error(`  Failed to install pack ${pack.source} for ${agent}:`, err);
      }
    }
  }

  return true;
}

/**
 * Add a source to skills.txt if not already present.
 */
function persistToManifest(manifestPath: string, source: string): void {
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `${source}\n`);
    console.log(`Created skills.txt with ${source}`);
    return;
  }

  const content = fs.readFileSync(manifestPath, 'utf-8');
  // Check if source already exists (ignoring comments and whitespace)
  const lines = content.split('\n').map((l) => l.split('#')[0].trim());
  if (!lines.includes(source)) {
    fs.appendFileSync(manifestPath, `\n${source}\n`);
    console.log(`Added ${source} to skills.txt`);
  }
}

// ============================================================================
// Binary Resolution
// ============================================================================

/**
 * Find the skills CLI binary. Resolution order:
 * 1. Bundled with @eve-horizon/cli (node_modules/.bin/skills)
 * 2. Global PATH
 */
function resolveSkillsBinary(): string {
  // 1. Check bundled binary (installed as dependency of @eve-horizon/cli)
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '.bin', 'skills'),
    path.resolve(__dirname, '..', '..', '.bin', 'skills'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 2. Global PATH
  if (commandExists('skills')) return 'skills';

  throw new Error(
    'skills CLI not found. Install it with:\n' +
    '  npm install -g skills',
  );
}

/**
 * Check if a command exists in PATH
 */
function commandExists(cmd: string): boolean {
  try {
    const result = spawnSync('which', [cmd], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Installed Skills
// ============================================================================

/**
 * Get list of installed skill names from .agents/skills directory.
 */
function getInstalledSkills(skillsDir: string): Set<string> {
  const installed = new Set<string>();

  if (!fs.existsSync(skillsDir)) {
    return installed;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      installed.add(entry.name);
    }
  }

  return installed;
}

/**
 * Ensure .claude/skills points at the universal skills directory (.agents/skills).
 */
function ensureSkillsSymlink(projectRoot: string): void {
  const agentSkills = path.join(projectRoot, UNIVERSAL_SKILLS_DIR);
  const claudeDir = path.join(projectRoot, '.claude');
  const claudeSkills = path.join(claudeDir, 'skills');

  // Ensure directories exist
  if (!fs.existsSync(agentSkills)) {
    fs.mkdirSync(agentSkills, { recursive: true });
  }
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // If .claude/skills is a real directory (committed overlay), keep it and
  // ensure it can "see" the universal skills by creating per-skill symlinks.
  if (fs.existsSync(claudeSkills) && !fs.lstatSync(claudeSkills).isSymbolicLink()) {
    try {
      const claudeStat = fs.lstatSync(claudeSkills);
      if (claudeStat.isDirectory()) {
        const entries = fs.readdirSync(agentSkills, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const dst = path.join(claudeSkills, entry.name);
          if (fs.existsSync(dst)) continue;

          // From <root>/.claude/skills/<name> -> <root>/.agents/skills/<name>
          fs.symlinkSync(path.join('..', '..', UNIVERSAL_SKILLS_DIR, entry.name), dst);
        }
      }
    } catch {
      // best-effort; don't block install
    }

    // Do not try to replace a real directory with a symlink.
    return;
  }

  // Check existing symlink
  if (fs.existsSync(claudeSkills)) {
    const stat = fs.lstatSync(claudeSkills);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(claudeSkills);
      if (target === `../${UNIVERSAL_SKILLS_DIR}` || target === agentSkills) {
        return; // Already correct
      }
      fs.unlinkSync(claudeSkills);
    } else {
      console.log('.claude/skills exists and is not a symlink; skipping');
      return;
    }
  }

  try {
    fs.symlinkSync(`../${UNIVERSAL_SKILLS_DIR}`, claudeSkills);
    console.log(`Linked .claude/skills -> ${UNIVERSAL_SKILLS_DIR}`);
  } catch (err) {
    console.warn('Warning: Failed to create symlink:', err);
  }
}

function resolveLocalDirIfExists(skill: SkillSource, projectRoot: string): string | null {
  if (skill.type !== 'local') return null;

  let source = skill.source;
  if (source.startsWith('~')) {
    source = source.replace(/^~/, process.env.HOME || '~');
  }

  const abs = path.isAbsolute(source) ? source : path.resolve(projectRoot, source);
  try {
    if (!fs.existsSync(abs)) return null;
    if (!fs.statSync(abs).isDirectory()) return null;
    return abs;
  } catch {
    return null;
  }
}

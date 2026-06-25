import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TEMPLATE = 'https://github.com/eve-horizon/eve-horizon-starter';
const DEFAULT_BRANCH = 'main';

// ============================================================================
// Main Handler
// ============================================================================

/**
 * eve init [directory] [--template <url>] [--branch <branch>]
 *
 * Initialize a new Eve Horizon project from a template.
 * Downloads the template, strips git history, and sets up a fresh project.
 */
export async function handleInit(
  positionals: string[],
  flags: Record<string, FlagValue>,
): Promise<void> {
  const targetDir = positionals[0] || '.';
  const template = getStringFlag(flags, ['template', 't']) || DEFAULT_TEMPLATE;
  const branch = getStringFlag(flags, ['branch', 'b']) || DEFAULT_BRANCH;
  const skipSkills = Boolean(flags['skip-skills']);

  // Resolve target directory
  const resolvedTarget = path.resolve(targetDir);
  const targetName = path.basename(resolvedTarget);
  const isCurrentDir = targetDir === '.';

  // Validate target directory
  if (isCurrentDir) {
    // Current directory must be empty or not exist
    if (fs.existsSync(resolvedTarget)) {
      const entries = fs.readdirSync(resolvedTarget);
      // Allow hidden files like .git, but fail if there's substantial content
      const nonHiddenEntries = entries.filter(e => !e.startsWith('.'));
      if (nonHiddenEntries.length > 0) {
        throw new Error(
          `Current directory is not empty. Remove existing files or specify a new directory name:\n` +
          `  eve init my-project`,
        );
      }
    }
  } else {
    // Named directory must not exist or be empty
    if (fs.existsSync(resolvedTarget)) {
      const entries = fs.readdirSync(resolvedTarget);
      if (entries.length > 0) {
        throw new Error(
          `Directory '${targetDir}' already exists and is not empty.`,
        );
      }
    }
  }

  console.log(`Initializing Eve Horizon project${isCurrentDir ? '' : ` in '${targetName}'`}...`);
  console.log(`Template: ${template}`);
  console.log(`Branch: ${branch}`);
  console.log('');

  // Create temp directory for clone
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-init-'));

  try {
    // Clone template
    console.log('Downloading template...');
    const cloneResult = spawnSync('git', ['clone', '--depth=1', `--branch=${branch}`, template, tempDir], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (cloneResult.status !== 0) {
      throw new Error(
        `Failed to clone template:\n${cloneResult.stderr || cloneResult.stdout}`,
      );
    }

    // Remove .git from cloned template
    const gitDir = path.join(tempDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // Create target directory if needed
    if (!fs.existsSync(resolvedTarget)) {
      fs.mkdirSync(resolvedTarget, { recursive: true });
    }

    // Copy template contents to target
    console.log('Setting up project...');
    copyDirRecursive(tempDir, resolvedTarget);

    // Initialize git
    console.log('Initializing git repository...');
    execSync('git init', { cwd: resolvedTarget, stdio: 'pipe' });
    execSync('git add -A', { cwd: resolvedTarget, stdio: 'pipe' });
    execSync('git commit -m "Initial commit from eve-horizon-starter"', {
      cwd: resolvedTarget,
      stdio: 'pipe',
    });

    // Install skills
    if (!skipSkills) {
      console.log('');
      console.log('Installing skills...');
      await installSkills(resolvedTarget);
    }

    // Success message
    console.log('');
    console.log('Project initialized successfully!');
    console.log('');
    console.log('Next steps:');
    if (!isCurrentDir) {
      console.log(`  1. cd ${targetName}`);
      console.log('  2. Start your AI coding agent (e.g., claude, cursor)');
      console.log('  3. Ask: "Run the eve-new-project-setup skill"');
    } else {
      console.log('  1. Start your AI coding agent (e.g., claude, cursor)');
      console.log('  2. Ask: "Run the eve-new-project-setup skill"');
    }
    console.log('');
    console.log('The setup skill will:');
    console.log('  - Install the Eve CLI if needed');
    console.log('  - Configure your profile and authentication');
    console.log('  - Set up your project manifest');
    console.log('  - Help you set up your own Git remote');

  } finally {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Recursively copy directory contents
 */
function copyDirRecursive(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(srcPath);
      if (!fs.existsSync(destPath)) {
        fs.symlinkSync(linkTarget, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Find the skills CLI binary (bundled dep first, then PATH).
 */
function resolveSkillsBinary(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '.bin', 'skills'),
    path.resolve(__dirname, '..', '..', '.bin', 'skills'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const result = spawnSync('which', ['skills'], { encoding: 'utf8' });
  if (result.status === 0) return 'skills';
  throw new Error(
    'skills CLI not found. Install it with:\n  npm install -g skills',
  );
}

/**
 * Install skills from skills.txt
 * This reuses the logic from the skills command
 */
async function installSkills(projectRoot: string): Promise<void> {
  const skillsTxt = path.join(projectRoot, 'skills.txt');

  if (!fs.existsSync(skillsTxt)) {
    console.log('No skills.txt found, skipping skill installation');
    return;
  }

  // Resolve skills binary (bundled dep first, then PATH)
  const skillsBin = resolveSkillsBinary();

  const agents = ['claude-code', 'codex', 'gemini-cli'];

  try {
    const content = fs.readFileSync(skillsTxt, 'utf-8');
    const lines = content.split('\n')
      .map(line => line.split('#')[0].trim())
      .filter(line => line.length > 0);

    for (const source of lines) {
      console.log(`  Installing: ${source}`);
      for (const agent of agents) {
        try {
          execSync(`${skillsBin} add ${JSON.stringify(source)} -a ${agent} -y --all`, {
            cwd: projectRoot,
            stdio: 'inherit',
            timeout: 120000,
          });
        } catch {
          console.log(`  Warning: Failed to install ${source} for ${agent}`);
        }
      }
    }

    // Ensure symlink
    ensureSkillsSymlink(projectRoot);

    // Commit skill changes
    try {
      execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
      const hasChanges = spawnSync('git', ['diff', '--cached', '--quiet'], {
        cwd: projectRoot,
        encoding: 'utf8',
      });
      if (hasChanges.status !== 0) {
        execSync('git commit -m "chore: install skills from skills.txt"', {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      }
    } catch {
      // Ignore commit failures
    }

  } catch (err) {
    console.log('Warning: Failed to install some skills');
  }
}

/**
 * Ensure .claude/skills points at the universal skills directory (.agents/skills).
 */
function ensureSkillsSymlink(projectRoot: string): void {
  const agentSkills = path.join(projectRoot, '.agents', 'skills');
  const claudeDir = path.join(projectRoot, '.claude');
  const claudeSkills = path.join(claudeDir, 'skills');

  if (!fs.existsSync(agentSkills)) {
    fs.mkdirSync(agentSkills, { recursive: true });
  }
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // If .claude/skills is a committed directory, keep it and add per-skill
  // symlinks so it can see universal skills too.
  if (fs.existsSync(claudeSkills) && !fs.lstatSync(claudeSkills).isSymbolicLink()) {
    try {
      const stat = fs.lstatSync(claudeSkills);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(agentSkills, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const dst = path.join(claudeSkills, entry.name);
          if (fs.existsSync(dst)) continue;
          fs.symlinkSync(path.join('..', '..', '.agents', 'skills', entry.name), dst);
        }
      }
    } catch {
      // best-effort
    }
    return;
  }

  if (fs.existsSync(claudeSkills)) {
    const stat = fs.lstatSync(claudeSkills);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(claudeSkills);
      if (target === '../.agents/skills' || target === agentSkills) {
        return;
      }
      fs.unlinkSync(claudeSkills);
    } else {
      return;
    }
  }

  try {
    fs.symlinkSync('../.agents/skills', claudeSkills);
  } catch {
    // Ignore symlink failures
  }
}

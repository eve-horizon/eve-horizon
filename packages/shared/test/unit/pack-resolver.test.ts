import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { resolvePack } from '../../src/lib/pack-resolver.js';

describe('pack-resolver exports', () => {
  test('resolvePack is exported as an async function', () => {
    expect(typeof resolvePack).toBe('function');
    expect(resolvePack.constructor.name).toBe('AsyncFunction');
  });
});

describe('pack-resolver: missing source', () => {
  test('resolvePack rejects missing local source', async () => {
    const entry = { source: './nonexistent-pack-dir-12345' };
    await expect(resolvePack(entry, 'my-proj')).rejects.toThrow('Local pack source not found');
  });
});

describe('pack-resolver: convention-based discovery (simple packs)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-resolver-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads agents.yaml from pack root when no eve/pack.yaml exists', async () => {
    const packDir = path.join(tmpDir, 'my-pack');
    fs.mkdirSync(packDir);
    fs.writeFileSync(
      path.join(packDir, 'agents.yaml'),
      'version: 1\nagents:\n  my-agent:\n    slug: my-agent\n    skill: my-skill\n',
    );

    const result = await resolvePack({ source: packDir }, 'test-proj');

    expect(result.id).toBe('my-pack');
    expect(result.agents).toHaveProperty('version', 1);
    expect(result.agents).toHaveProperty('agents');
    const agents = result.agents.agents as Record<string, unknown>;
    expect(agents).toHaveProperty('my-agent');
    const agent = agents['my-agent'] as Record<string, unknown>;
    // Slug should be prefixed with project slug
    expect(agent.slug).toBe('test-proj-my-agent');
  });

  test('handles agents.yaml with empty agents gracefully', async () => {
    const packDir = path.join(tmpDir, 'empty-pack');
    fs.mkdirSync(packDir);
    fs.writeFileSync(path.join(packDir, 'agents.yaml'), 'version: 1\nagents: {}\n');

    const result = await resolvePack({ source: packDir }, 'test-proj');

    expect(result.agents).toHaveProperty('version', 1);
    expect(result.agents).toHaveProperty('agents');
    expect(result.agents.agents).toEqual({});
  });

  test('returns empty agents when no agents.yaml exists (skills-only)', async () => {
    const packDir = path.join(tmpDir, 'skills-only');
    fs.mkdirSync(packDir);
    fs.mkdirSync(path.join(packDir, 'skills'));

    const result = await resolvePack({ source: packDir }, 'test-proj');

    expect(result.agents).toEqual({});
    expect(result.teams).toEqual({});
  });

  test('loads teams.yaml and chat.yaml from pack root', async () => {
    const packDir = path.join(tmpDir, 'full-pack');
    fs.mkdirSync(packDir);
    fs.writeFileSync(
      path.join(packDir, 'agents.yaml'),
      'version: 1\nagents:\n  a1:\n    skill: s1\n',
    );
    fs.writeFileSync(
      path.join(packDir, 'teams.yaml'),
      'version: 1\nteams:\n  t1:\n    lead: a1\n    members: [a1]\n',
    );
    fs.writeFileSync(
      path.join(packDir, 'chat.yaml'),
      'version: 1\nroutes:\n  - id: r1\n    match: /ask\n    target: a1\n',
    );

    const result = await resolvePack({ source: packDir }, 'test-proj');

    expect(result.agents).toHaveProperty('version', 1);
    expect(result.teams).toHaveProperty('version', 1);
    expect(result.teams).toHaveProperty('teams');
    expect(result.chat).not.toBeNull();
    expect(result.chat).toHaveProperty('routes');
  });

  test('discovers skills alongside convention-based agents', async () => {
    const packDir = path.join(tmpDir, 'mixed-pack');
    fs.mkdirSync(packDir);
    fs.writeFileSync(path.join(packDir, 'agents.yaml'), 'version: 1\nagents: {}\n');
    fs.mkdirSync(path.join(packDir, 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'skills', 'my-skill', 'SKILL.md'), '# My Skill');

    const result = await resolvePack({ source: packDir }, 'test-proj');

    expect(result.skillPaths).toHaveLength(1);
    expect(result.skillPaths[0]).toContain('my-skill');
  });

  test('fetches arbitrary remote SHAs instead of assuming default-branch HEAD', async () => {
    const repoDir = path.join(tmpDir, 'remote-pack');
    fs.mkdirSync(repoDir);
    execSync('git init -b main', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'pipe' });

    fs.mkdirSync(path.join(repoDir, 'skills', 'alpha-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'skills', 'alpha-skill', 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Alpha\n---\n# Alpha\n',
    );
    execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit -m "alpha"', { cwd: repoDir, stdio: 'pipe' });
    const firstSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    fs.rmSync(path.join(repoDir, 'skills', 'alpha-skill'), { recursive: true, force: true });
    fs.mkdirSync(path.join(repoDir, 'skills', 'beta-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'skills', 'beta-skill', 'SKILL.md'),
      '---\nname: beta-skill\ndescription: Beta\n---\n# Beta\n',
    );
    execSync('git add -A', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit -m "beta"', { cwd: repoDir, stdio: 'pipe' });

    const result = await resolvePack({ source: `file://${repoDir}`, ref: firstSha }, 'test-proj');

    expect(result.rootPath).toContain(firstSha);
    expect(result.skillPaths).toHaveLength(1);
    expect(result.skillPaths[0]).toContain('alpha-skill');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  materializeResolvedSkillSources,
  prepareSkillSourcesForWorkspace,
  type ResolvedSkillSource,
} from '../../src/skills/index.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(skillDir: string, name: string, description = 'Test skill'): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

describe('skills materializer', () => {
  it('materializes canonical skills and creates claude/pi bridges', async () => {
    const projectRoot = createTempDir('skills-materializer-local-');
    const sourceRoot = createTempDir('skills-materializer-source-');
    const skillDir = path.join(sourceRoot, 'vercel-react-best-practices');
    writeSkill(skillDir, 'Vercel React Best Practices');

    const source: ResolvedSkillSource = {
      id: 'local-source',
      source: './skills/vercel-react-best-practices',
      origin: 'skills-txt',
      sourceType: 'local',
      resolvedRoot: skillDir,
      installAgents: ['claude-code', 'codex', 'pi'],
      skills: [
        {
          name: 'Vercel React Best Practices',
          description: 'Test skill',
          installName: 'vercel-react-best-practices',
          skillPath: skillDir,
        },
      ],
    };

    const result = await materializeResolvedSkillSources(projectRoot, [source], { mode: 'symlink' });

    const canonical = path.join(projectRoot, '.agents', 'skills', 'vercel-react-best-practices');
    const claudeSkills = path.join(projectRoot, '.claude', 'skills');
    const piSkill = path.join(projectRoot, '.pi', 'skills', 'vercel-react-best-practices');

    expect(result.materialized).toHaveLength(1);
    expect(fs.lstatSync(canonical).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(canonical, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(claudeSkills)).toBe(true);
    expect(fs.existsSync(piSkill)).toBe(true);
  });

  it('vendors remote sources into the committed sidecar and preserves copy filters', async () => {
    const projectRoot = createTempDir('skills-materializer-project-');
    const remoteRoot = createTempDir('skills-materializer-remote-');
    const skillDir = path.join(remoteRoot, 'skills', 'remote-skill');
    writeSkill(skillDir, 'Remote Skill');
    fs.writeFileSync(path.join(skillDir, 'README.md'), 'skip');
    fs.writeFileSync(path.join(skillDir, 'metadata.json'), '{}');
    fs.writeFileSync(path.join(skillDir, '_draft.txt'), 'skip');
    fs.mkdirSync(path.join(skillDir, '_partials'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '_partials', 'note.txt'), 'skip');
    fs.mkdirSync(path.join(skillDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.git', 'config'), 'skip');
    fs.mkdirSync(path.join(skillDir, '.github'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.github', 'workflow.yml'), 'keep');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'references', 'guide.md'), 'keep');

    const source: ResolvedSkillSource = {
      id: 'remote-skill-source',
      source: 'github:example/remote-pack',
      ref: '1234567890abcdef1234567890abcdef12345678',
      origin: 'manifest-pack',
      sourceType: 'remote',
      resolvedRoot: remoteRoot,
      installAgents: ['claude-code'],
      skills: [
        {
          name: 'Remote Skill',
          description: 'Test skill',
          installName: 'remote-skill',
          skillPath: skillDir,
        },
      ],
    };

    const vendored = await prepareSkillSourcesForWorkspace(projectRoot, [source], {
      vendorExternalSources: true,
    });

    const sidecarSkill = path.join(
      projectRoot,
      '.eve',
      'materialized-skills',
      source.id,
      'remote-skill',
    );

    expect(vendored[0]?.sourceType).toBe('vendored');
    expect(fs.existsSync(path.join(projectRoot, '.eve', 'materialized-skills', 'index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(sidecarSkill, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(sidecarSkill, 'metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(sidecarSkill, '_draft.txt'))).toBe(false);
    expect(fs.existsSync(path.join(sidecarSkill, '_partials'))).toBe(false);
    expect(fs.existsSync(path.join(sidecarSkill, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(sidecarSkill, '.github', 'workflow.yml'))).toBe(true);
    expect(fs.existsSync(path.join(sidecarSkill, 'references', 'guide.md'))).toBe(true);

    const runtimePrepared = await prepareSkillSourcesForWorkspace(projectRoot, [source], {
      runtimeOnly: true,
    });

    expect(runtimePrepared[0]?.sourceType).toBe('vendored');
    expect(runtimePrepared[0]?.skills[0]?.skillPath).toBe(sidecarSkill);
  });
});

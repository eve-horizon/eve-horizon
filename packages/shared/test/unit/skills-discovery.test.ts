import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverSkillDefinition,
  resolveManifestSkillMode,
  resolveSkillsTxtSkillSources,
  sanitizeSkillName,
} from '../../src/skills/index.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempRepo(prefix: string): string {
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

describe('skills discovery', () => {
  it('sanitizes skill names with upstream-compatible rules', () => {
    expect(sanitizeSkillName('Convex Best Practices')).toBe('convex-best-practices');
    expect(sanitizeSkillName('../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeSkillName('docs.example.com')).toBe('docs.example.com');
    expect(sanitizeSkillName('你好')).toBe('unnamed-skill');
  });

  it('discovers install names from SKILL frontmatter instead of directory basename', () => {
    const root = createTempRepo('skills-discovery-frontmatter-');
    const skillDir = path.join(root, 'react-best-practices');
    writeSkill(skillDir, 'Vercel React Best Practices');

    const skill = discoverSkillDefinition(skillDir);
    expect(skill.installName).toBe('vercel-react-best-practices');
    expect(skill.skillPath).toBe(skillDir);
  });

  it('resolves only local skills.txt sources for fast-path materialization', () => {
    const root = createTempRepo('skills-discovery-skills-txt-');
    const skillDir = path.join(root, 'skills', 'react-best-practices');
    writeSkill(skillDir, 'Vercel React Best Practices');
    fs.writeFileSync(
      path.join(root, 'skills.txt'),
      [
        'https://github.com/eve-horizon/eve-skillpacks',
        './skills/react-best-practices',
      ].join('\n'),
    );

    const sources = resolveSkillsTxtSkillSources(root, { localOnly: true });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.skills[0]?.installName).toBe('vercel-react-best-practices');
  });

  it('falls back to runtime and software-engineering modes when skill_modes are absent', () => {
    const manifest = {
      name: 'example-project',
      services: {},
      'x-eve': {
        install_agents: ['claude-code', 'pi'],
        packs: [{ source: './skillpacks/runtime' }],
      },
    } as any;

    const runtime = resolveManifestSkillMode(manifest, 'runtime');
    const softwareEngineering = resolveManifestSkillMode(manifest, 'software-engineering');

    expect(runtime.includeManifestPacks).toBe(true);
    expect(runtime.includeSkillsTxt).toBe(false);
    expect(runtime.installAgents).toEqual(['claude-code', 'pi']);
    expect(softwareEngineering.includeSkillsTxt).toBe(true);
    expect(softwareEngineering.packs).toHaveLength(1);
  });
});

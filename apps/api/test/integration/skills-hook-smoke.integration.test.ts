import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '../..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

function isExplicitLocalPath(value: string): boolean {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.startsWith('~')
  );
}

function isRemoteSource(value: string): boolean {
  return (
    value.startsWith('https://') ||
    value.startsWith('http://') ||
    value.startsWith('git@') ||
    value.startsWith('github:') ||
    /^[^\s]+\/[^\s]+$/.test(value)
  );
}

describe('integration skills hook smoke', () => {
  it('on-clone hook assumes runtime already materialized skills', () => {
    const hook = readRepoFile('.eve/hooks/on-clone.sh');
    expect(hook).toContain('Skills already materialized by runtime');
    expect(hook).not.toContain('eve skills install');
    expect(hook).not.toContain('eve-worker');
  });

  it('skills installer prefers eve CLI with skills CLI fallback', () => {
    const installer = readRepoFile('bin/eh-commands/skills.sh');
    // Prefers eve CLI when available
    expect(installer).toContain('eve skills install');
    // Falls back to skills CLI directly
    expect(installer).toContain('skills add');
    expect(installer).not.toContain('openskills');
    // No eve-worker references
    expect(installer).not.toContain('eve-worker');
  });

  it('eve-cli uses skills add with per-agent installation', () => {
    const cliSkills = readRepoFile('packages/cli/src/commands/skills.ts');
    // Uses skills CLI, not openskills
    expect(cliSkills).toContain("commandExists('skills')");
    expect(cliSkills).not.toContain('openskills');
    // Installs per agent including pi
    expect(cliSkills).toContain('claude-code');
    expect(cliSkills).toContain('codex');
    expect(cliSkills).toContain('gemini-cli');
    expect(cliSkills).toContain("'pi'");
    // Resolves bundled skills binary and calls add
    expect(cliSkills).toContain('resolveSkillsBinary');
    expect(cliSkills).toContain("add ${JSON.stringify(skill.source)}");
  });

  it('eve-cli exposes fast materialization for manifest and local skills.txt sources', () => {
    const cliSkills = readRepoFile('packages/cli/src/commands/skills.ts');
    const materialize = readRepoFile('packages/cli/src/lib/skills-materialize.ts');

    expect(cliSkills).toContain("case 'materialize'");
    expect(materialize).toContain('resolveManifestSkillSources');
    expect(materialize).toContain('resolveSkillsTxtSkillSources');
    expect(materialize).toContain('materializeResolvedSkillSources');
  });

  it('eve-cli supports pack-based installation from manifest', () => {
    const cliSkills = readRepoFile('packages/cli/src/commands/skills.ts');
    expect(cliSkills).toContain('installPackSkills');
    expect(cliSkills).toContain('manifest.yaml');
    expect(cliSkills).toContain('packs.lock.yaml');
    expect(cliSkills).toContain('x-eve');
  });

  it('docker worker uses skills CLI with pi in agents list', () => {
    const eveSkills = readRepoFile('docker/worker/eve-skills');
    expect(eveSkills).toContain('skills add');
    expect(eveSkills).not.toContain('openskills');
    // Agent list includes pi
    expect(eveSkills).toContain('claude-code');
    expect(eveSkills).toContain('codex');
    expect(eveSkills).toContain('gemini-cli');
    expect(eveSkills).toContain('pi');
  });

  it('worker Dockerfile installs skills package, not openskills', () => {
    const dockerfile = readRepoFile('apps/worker/Dockerfile');
    expect(dockerfile).toContain('INSTALL_SKILLS=true');
    expect(dockerfile).not.toContain('INSTALL_OPENSKILLS');
    expect(dockerfile).toContain('DISABLE_TELEMETRY=1');
    // Development stage also uses skills
    expect(dockerfile).toMatch(/\bskills(?:@|\s|\\)/);
    expect(dockerfile).not.toContain('openskills \\');
    // No worker-cli references
    expect(dockerfile).not.toContain('worker-cli');
  });

  it('no AGENTS.md sync in skills installation flow', () => {
    const cliSkills = readRepoFile('packages/cli/src/commands/skills.ts');
    const eveSkills = readRepoFile('docker/worker/eve-skills');

    // AGENTS.md sync removed from all paths
    expect(cliSkills).not.toContain('syncAgentsMd');
    expect(cliSkills).not.toContain('openskills sync');
    expect(eveSkills).not.toContain('openskills sync');
    expect(eveSkills).not.toContain('AGENTS.md');
  });

  it('pi harness does not disable skills', () => {
    const piHarness = readRepoFile('packages/eve-agent-cli/src/harnesses/pi.ts');
    expect(piHarness).not.toContain('--no-skills');
    // Still disables other container-hostile features
    expect(piHarness).toContain('--no-extensions');
    expect(piHarness).toContain('--no-themes');
    expect(piHarness).toContain('--no-prompt-templates');
  });

  it('skills manifest uses explicit local paths or remote repos', () => {
    const manifest = readRepoFile('skills.txt');
    const entries = manifest
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line.length > 0);

    for (const entry of entries) {
      expect(isExplicitLocalPath(entry) || isRemoteSource(entry)).toBe(true);
    }
  });
});

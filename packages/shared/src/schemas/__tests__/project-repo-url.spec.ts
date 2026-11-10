import { describe, expect, it } from 'vitest';
import {
  BootstrapProjectRequestSchema,
  CreateProjectRequestSchema,
  EnsureProjectRequestSchema,
  UpdateProjectRequestSchema,
} from '../project.js';

const base = { org_id: 'org_abc123', name: 'demo' };

function create(repoUrl: string) {
  return CreateProjectRequestSchema.safeParse({ ...base, repo_url: repoUrl });
}

describe('project repo_url', () => {
  it.each([
    'https://github.com/org/repo',
    'https://github.com/org/repo.git',
    'https://github.com/eve-horizon/eve-horizon-fullstack-example',
    'https://x-access-token:ghp_abc123@github.com/example-org/reference-app.git',
    'https://gitlab.com/group/sub-group/repo.git',
    'https://dev.azure.com/org/project/_git/repo',
    'https://git.example.com:8443/org/repo.git',
    'http://gitea.lvh.me:3000/org/repo.git',
    'git@github.com:org/repo.git',
    'git@gitlab.com:group/sub-group/repo.git',
    'deploy_user@git.example.com:org/repo',
    'file:///tmp/sparse-agent-app',
    'file:///workspaces/eve-horizon',
    'file:///Users/me/dev/My%20Repo',
  ])('accepts %s', (repoUrl) => {
    const result = create(repoUrl);
    expect(result.success).toBe(true);
    expect(result.success && result.data.repo_url).toBe(repoUrl);
  });

  it('trims surrounding whitespace', () => {
    const result = create('  https://github.com/org/repo\n');
    expect(result.success).toBe(true);
    expect(result.success && result.data.repo_url).toBe('https://github.com/org/repo');
  });

  it.each([
    ['a command substitution', 'https://github.com/org/repo$(id)'],
    ['a variable', 'https://github.com/org/$HOME'],
    ['a backtick', 'https://github.com/org/repo`id`'],
    ['a semicolon', 'https://github.com/org/repo;id'],
    ['a pipe', 'https://github.com/org/repo|id'],
    ['an ampersand', 'https://github.com/org/repo&id'],
    ['a less-than sign', 'https://github.com/org/repo<id'],
    ['a greater-than sign', 'https://github.com/org/repo>id'],
    ['parentheses', 'https://github.com/org/(repo)'],
    ['a single quote', "https://github.com/org/repo'id"],
    ['a double quote', 'https://github.com/org/repo"id'],
    ['a backslash', 'https://github.com/org/repo\\id'],
    ['an inner space', 'https://github.com/org/my repo'],
    ['an inner tab', 'https://github.com/org/my\trepo'],
    ['an inner newline', 'https://github.com/org/repo\nid'],
    ['a NUL character', 'https://github.com/org/repo\u0000id'],
    ['a DEL character', 'https://github.com/org/repo\u007fid'],
    ['a file URL with a semicolon', 'file:///tmp/repo;id'],
    ['a leading dash', '--upload-pack@host:org/repo'],
    ['an SSH host starting with a dash', 'git@-oProxyCommand:org/repo'],
    ['an SSH URL with a command substitution', 'git@github.com:org/repo$(id)'],
    ['an unsupported scheme', 'ftp://example.com/org/repo.git'],
    ['a bare owner/repo', 'org/repo'],
  ])('rejects %s', (_label, repoUrl) => {
    expect(create(repoUrl).success).toBe(false);
  });

  it('applies the same rule to ensure, update and bootstrap requests', () => {
    const bad = 'https://github.com/org/repo$(id)';
    expect(EnsureProjectRequestSchema.safeParse({ ...base, repo_url: bad }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ repo_url: bad }).success).toBe(false);
    expect(BootstrapProjectRequestSchema.safeParse({ ...base, repo_url: bad }).success).toBe(false);

    const good = 'https://github.com/org/repo';
    expect(EnsureProjectRequestSchema.safeParse({ ...base, repo_url: good }).success).toBe(true);
    expect(UpdateProjectRequestSchema.safeParse({ repo_url: good }).success).toBe(true);
    expect(BootstrapProjectRequestSchema.safeParse({ ...base, repo_url: good }).success).toBe(true);
  });
});

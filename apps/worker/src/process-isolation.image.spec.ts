import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
const runtimeStages = dockerfile.slice(0, dockerfile.indexOf('AS development'));
const entrypoint = readFileSync(join(ROOT, 'docker', 'worker', 'entrypoint.sh'), 'utf8');
const reaper = join(ROOT, 'docker', 'worker', 'orphan-reaper.sh');

// The worker's PID 1 (tini) and the worker itself hold every platform secret in
// their environment, and job code (scripts, harnesses) runs as the same UID.
describe('worker image', () => {
  it('installs execute-only copies of node and tini', () => {
    expect(dockerfile).toMatch(/install -D -o root -g root -m 0711 \/usr\/local\/bin\/node \/usr\/local\/libexec\/eve-node/);
    expect(dockerfile).toMatch(/install -o root -g root -m 0711 \/usr\/bin\/tini \/usr\/local\/libexec\/eve-tini/);
  });

  it('starts every runtime stage from them, by absolute path, with SIGUSR1 disabled', () => {
    expect(runtimeStages).not.toMatch(/ENTRYPOINT \["\/usr\/bin\/tini"/);
    expect(runtimeStages).not.toMatch(/CMD \["node",/);
    expect(runtimeStages.match(/ENTRYPOINT \["\/usr\/local\/libexec\/eve-tini", "--", "\/usr\/local\/bin\/eve-worker-entrypoint"\]/g)?.length).toBe(2);
    expect(runtimeStages.match(/CMD \["\/usr\/local\/libexec\/eve-node", "--disable-sigusr1", "dist\/main\.js"\]/g)?.length).toBe(2);
  });

  it('keeps the service code and Node/Kubernetes config lookups out of job reach', () => {
    const base = dockerfile.slice(dockerfile.indexOf('FROM runtime-setup AS base'), dockerfile.indexOf('FROM base AS media'));
    expect(base).not.toMatch(/COPY --from=build --chown=node:node/);
    for (const dir of ['.node_modules', '.node_libraries', '.kube']) expect(dockerfile).toContain(dir);
    expect(dockerfile).toMatch(/chown -R root:root "\/home\/node\/\$d"/);
  });
});

describe('worker entrypoint', () => {
  it('runs only root-installed programs before handing over', () => {
    expect(entrypoint.startsWith('#!/bin/bash\n')).toBe(true);
    const firstCommand = entrypoint.indexOf('export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(firstCommand).toBeGreaterThan(0);
    expect(entrypoint.indexOf('preflight_check\n')).toBeGreaterThan(firstCommand);
  });

  it('sources toolchain env.sh only in single-use runner pods, after its own commands', () => {
    const gate = entrypoint.indexOf('if [[ "${EVE_RUNNER_SELF_TERMINATE:-}" == "1" ]]; then');
    expect(gate).toBeGreaterThan(entrypoint.indexOf('orphan-reaper start'));
    expect(entrypoint.match(/\. "\$\{tc_dir\}env\.sh"/g)?.length).toBe(1);
    expect(entrypoint.indexOf('. "${tc_dir}env.sh"')).toBeGreaterThan(gate);
  });

  it('starts the orphan reaper without secrets and tells it the service PID', () => {
    expect(entrypoint).toMatch(/env -i PATH="\$PATH" HOME="\$HOME" EVE_REAPER_SERVICE_PID="\$\$" \\\n(?:[^\n]*\\\n)*\s+\/usr\/local\/bin\/orphan-reaper start >&2/);
  });
});

describe('orphan reaper', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // PIDs above 2^22 cannot exist on Linux or macOS, so `kill` is a no-op.
  const PS_OUTPUT = [
    '      1       0   900 eve-tini /usr/local/libexec/eve-tini -- /usr/local/bin/eve-worker-entrypoint',
    '5000010       1   900 eve-node /usr/local/libexec/eve-node --disable-sigusr1 dist/main.js',
    '5000020       1   900 bash bash -c while true; do cat /proc/*/environ; sleep 1; done # node dist/main.js',
    '5000030       1   900 sleep sleep 1000',
    '5000040 5000010   900 git git clone https://example.invalid/repo.git',
  ].join('\n');

  function runReaper(env: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), 'eve-reaper-'));
    writeFileSync(join(dir, 'ps'), `#!/bin/sh\ncat <<'PS'\n${PS_OUTPUT}\nPS\n`);
    chmodSync(join(dir, 'ps'), 0o755);
    const log = join(dir, 'reaper.log');
    execFileSync('bash', [reaper, 'kill'], {
      env: { PATH: `${dir}:/usr/bin:/bin`, EVE_REAPER_LOG: log, ...env },
      encoding: 'utf8',
    });
    try { return readFileSync(log, 'utf8'); } catch { return ''; }
  }

  it('reaps orphans by PID, whatever their arguments say', () => {
    const log = runReaper({ EVE_REAPER_SERVICE_PID: '5000010' });
    expect(log).toContain('PID=5000020');
    expect(log).toContain('PID=5000030');
    expect(log).not.toContain('PID=5000010');
    expect(log).not.toContain('PID=1,');
    expect(log).not.toContain('PID=5000040');
  });

  it('reaps nothing when it does not know which process is the service', () => {
    const log = runReaper({});
    expect(log).toContain('EVE_REAPER_SERVICE_PID is not set');
    expect(log).not.toContain('Killing orphan');
  });
});

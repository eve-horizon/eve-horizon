import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The worker's PID 1 (tini) and the worker itself hold the platform secrets in
// their environment. Both must start from execute-only binaries so the kernel
// marks them non-dumpable and in-process scripts (same UID) cannot read
// /proc/<pid>/environ.
describe('worker image', () => {
  const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
  const runtimeStages = dockerfile.slice(0, dockerfile.indexOf('AS development'));

  it('installs execute-only copies of node and tini', () => {
    expect(dockerfile).toMatch(/install -D -o root -g root -m 0711 \/usr\/local\/bin\/node \/usr\/local\/libexec\/eve-node/);
    expect(dockerfile).toMatch(/install -o root -g root -m 0711 \/usr\/bin\/tini \/usr\/local\/libexec\/eve-tini/);
  });

  it('starts every runtime stage from them', () => {
    expect(runtimeStages).not.toMatch(/ENTRYPOINT \["\/usr\/bin\/tini"/);
    expect(runtimeStages).not.toMatch(/CMD \["node",/);
    expect(runtimeStages.match(/ENTRYPOINT \["\/usr\/local\/libexec\/eve-tini", "--", "eve-worker-entrypoint"\]/g)?.length).toBe(2);
    expect(runtimeStages.match(/CMD \["\/usr\/local\/libexec\/eve-node", "dist\/main\.js"\]/g)?.length).toBe(2);
  });

  it('keeps worker secrets out of the long-lived orphan reaper', () => {
    const entrypoint = readFileSync(join(__dirname, '..', '..', '..', 'docker', 'worker', 'entrypoint.sh'), 'utf8');
    // The reaper start must be the tail of a single `env -i ...` command.
    expect(entrypoint).toMatch(/env -i PATH="\$PATH" HOME="\$HOME" \\\n(?:[^\n]*\\\n)*\s+orphan-reaper start >&2/);
    expect(entrypoint.match(/orphan-reaper start/g)?.length).toBe(1);
  });
});

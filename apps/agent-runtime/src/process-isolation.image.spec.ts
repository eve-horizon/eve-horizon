import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The runtime must start from an execute-only interpreter so the kernel marks it
// non-dumpable and harnesses (same UID) cannot read /proc/<pid>/environ.
describe('agent-runtime image', () => {
  const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
  const production = dockerfile.slice(dockerfile.indexOf('AS production'), dockerfile.indexOf('AS development'));

  it('installs an execute-only copy of node', () => {
    expect(production).toMatch(/install -D -o root -g root -m 0711 \/usr\/local\/bin\/node \/usr\/local\/libexec\/eve-node/);
  });

  it('starts the runtime from it as a non-root user', () => {
    expect(production).toMatch(/USER node\nCMD \["\/usr\/local\/libexec\/eve-node", "dist\/main\.js"\]/);
    expect(production).not.toMatch(/CMD \["node",/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The runtime must start from an execute-only interpreter so the kernel marks it
// non-dumpable and harnesses (same UID) cannot read /proc/<pid>/environ, and with
// --disable-sigusr1 so they cannot open its inspector.
describe('agent-runtime image', () => {
  const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
  const production = dockerfile.slice(dockerfile.indexOf('AS production'), dockerfile.indexOf('AS development'));

  it('installs an execute-only copy of node', () => {
    expect(production).toMatch(/install -D -o root -g root -m 0711 \/usr\/local\/bin\/node \/usr\/local\/libexec\/eve-node/);
  });

  it('starts the runtime from it as a non-root user, with SIGUSR1 disabled', () => {
    expect(production).toMatch(/USER node\n(?:#[^\n]*\n)*CMD \["\/usr\/local\/libexec\/eve-node", "--disable-sigusr1", "dist\/main\.js"\]/);
    expect(production).not.toMatch(/CMD \["node",/);
  });

  it('keeps Node and Kubernetes config lookups in HOME out of harness reach', () => {
    for (const dir of ['.node_modules', '.node_libraries', '.kube']) expect(production).toContain(dir);
    expect(production).toMatch(/chown -R root:root "\/home\/node\/\$d"/);
    // The guards come after the last recursive chown of /home/node.
    expect(production.indexOf('chown -R root:root "/home/node/$d"'))
      .toBeGreaterThan(production.lastIndexOf('chown -R node:node /home/node'));
  });
});

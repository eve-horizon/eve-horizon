import { describe, expect, it } from 'vitest';
import {
  appendProvisionedToolchainEnv,
  buildToolchainRuntimeMeta,
  formatToolchainEvent,
  recordToolchainEvent,
  splitToolchainPathPrefix,
} from './toolchains';

describe('agent-runtime toolchain helpers', () => {
  it('formats provisioning events with worker-compatible wording', () => {
    expect(formatToolchainEvent({ type: 'cache_hit', toolchain: 'python' })).toBe('Toolchain python cache hit');
    expect(formatToolchainEvent({ type: 'install_start', toolchain: 'python' })).toBe('Installing toolchain python');
    expect(formatToolchainEvent({ type: 'env_loaded', toolchain: 'python' })).toBe('Loaded toolchain python environment');
  });

  it('records runtime metadata for cache hits', () => {
    const events = new Map<string, Set<string>>();
    recordToolchainEvent(events, { type: 'cache_hit', toolchain: 'python' });
    recordToolchainEvent(events, { type: 'env_loaded', toolchain: 'python' });

    expect(buildToolchainRuntimeMeta({
      executionMode: 'inline',
      requested: ['python', 'python'],
      resolved: ['python'],
      missing: [],
      eventsByToolchain: events,
    })).toEqual({
      execution_mode: 'inline',
      requested: ['python'],
      resolved: ['python'],
      missing: [],
      source: 'cache_hit',
      events: {
        python: ['cache_hit', 'env_loaded'],
      },
    });
  });

  it('records mixed metadata when some toolchains install and others hit cache', () => {
    const events = new Map<string, Set<string>>();
    recordToolchainEvent(events, { type: 'cache_hit', toolchain: 'python' });
    recordToolchainEvent(events, { type: 'install_start', toolchain: 'rust' });
    recordToolchainEvent(events, { type: 'install_done', toolchain: 'rust' });

    expect(buildToolchainRuntimeMeta({
      executionMode: 'inline',
      requested: ['python', 'rust'],
      resolved: ['python', 'rust'],
      eventsByToolchain: events,
    }).source).toBe('mixed');
  });

  it('builds runner-pod metadata from init containers', () => {
    expect(buildToolchainRuntimeMeta({
      executionMode: 'runner',
      requested: ['python'],
      resolved: ['python'],
      missing: [],
    })).toEqual({
      execution_mode: 'runner',
      requested: ['python'],
      resolved: ['python'],
      missing: [],
      source: 'init_container',
    });
  });

  it('injects provisioned bin paths and env overlay', () => {
    const binPaths = ['/app/node_modules/.bin'];
    const adapterEnv: Record<string, string | undefined> = { EXISTING: '1' };

    appendProvisionedToolchainEnv({
      resolved: ['python'],
      missing: [],
      pathPrefix: '/opt/eve/toolchains/python/bin:/opt/eve/toolchains/media/bin',
      envOverlay: { PYTHONHOME: '/opt/eve/toolchains/python' },
      env: {},
    }, binPaths, adapterEnv);

    expect(binPaths).toEqual([
      '/app/node_modules/.bin',
      '/opt/eve/toolchains/python/bin',
      '/opt/eve/toolchains/media/bin',
    ]);
    expect(adapterEnv).toEqual({
      EXISTING: '1',
      PYTHONHOME: '/opt/eve/toolchains/python',
    });
  });

  it('drops empty path-prefix segments', () => {
    expect(splitToolchainPathPrefix(':/opt/eve/toolchains/python/bin:')).toEqual([
      '/opt/eve/toolchains/python/bin',
    ]);
  });
});

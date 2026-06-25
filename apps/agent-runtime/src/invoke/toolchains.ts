import * as path from 'path';
import type { ToolchainCacheEvent, ToolchainProvisionResult } from '@eve/shared';

type ToolchainExecutionMode = 'inline' | 'runner';
type ToolchainSource = 'cache_hit' | 'installed' | 'mixed' | 'init_container' | 'unavailable';

export interface ToolchainRuntimeMeta {
  execution_mode: ToolchainExecutionMode;
  requested: string[];
  resolved: string[];
  missing: string[];
  source: ToolchainSource;
  events?: Record<string, string[]>;
  error_code?: string;
  error?: string;
  toolchain?: string;
  image?: string;
}

export function formatToolchainEvent(event: ToolchainCacheEvent): string {
  switch (event.type) {
    case 'cache_hit':
      return `Toolchain ${event.toolchain} cache hit`;
    case 'install_wait':
      return `Waiting for toolchain ${event.toolchain} install`;
    case 'install_start':
      return `Installing toolchain ${event.toolchain}`;
    case 'install_done':
      return `Installed toolchain ${event.toolchain}`;
    case 'env_loaded':
      return `Loaded toolchain ${event.toolchain} environment`;
  }
}

export function recordToolchainEvent(
  eventsByToolchain: Map<string, Set<string>>,
  event: ToolchainCacheEvent,
): void {
  const events = eventsByToolchain.get(event.toolchain) ?? new Set<string>();
  events.add(event.type);
  eventsByToolchain.set(event.toolchain, events);
}

export function toolchainEventsToRecord(
  eventsByToolchain: Map<string, Set<string>>,
): Record<string, string[]> | undefined {
  if (eventsByToolchain.size === 0) return undefined;
  const entries = Array.from(eventsByToolchain.entries()).map(([toolchain, events]) => [
    toolchain,
    Array.from(events).sort(),
  ]);
  return Object.fromEntries(entries);
}

export function deriveToolchainSource(
  eventsByToolchain: Map<string, Set<string>>,
  fallback: ToolchainSource = 'cache_hit',
): ToolchainSource {
  let sawCacheHit = false;
  let sawInstall = false;

  for (const events of eventsByToolchain.values()) {
    sawCacheHit = sawCacheHit || events.has('cache_hit');
    sawInstall = sawInstall || events.has('install_done') || events.has('install_start');
  }

  if (sawCacheHit && sawInstall) return 'mixed';
  if (sawInstall) return 'installed';
  if (sawCacheHit) return 'cache_hit';
  return fallback;
}

export function buildToolchainRuntimeMeta(params: {
  executionMode: ToolchainExecutionMode;
  requested: readonly string[];
  resolved?: readonly string[];
  missing?: readonly string[];
  source?: ToolchainSource;
  eventsByToolchain?: Map<string, Set<string>>;
  errorCode?: string;
  error?: string;
  toolchain?: string;
  image?: string;
}): ToolchainRuntimeMeta {
  const events = params.eventsByToolchain
    ? toolchainEventsToRecord(params.eventsByToolchain)
    : undefined;

  return {
    execution_mode: params.executionMode,
    requested: [...new Set(params.requested)],
    resolved: [...new Set(params.resolved ?? [])],
    missing: [...new Set(params.missing ?? [])],
    source: params.source ?? (
      params.eventsByToolchain
        ? deriveToolchainSource(params.eventsByToolchain)
        : params.executionMode === 'runner'
          ? 'init_container'
          : 'cache_hit'
    ),
    ...(events ? { events } : {}),
    ...(params.errorCode ? { error_code: params.errorCode } : {}),
    ...(params.error ? { error: params.error } : {}),
    ...(params.toolchain ? { toolchain: params.toolchain } : {}),
    ...(params.image ? { image: params.image } : {}),
  };
}

export function appendProvisionedToolchainEnv(
  provisioned: ToolchainProvisionResult,
  binPaths: string[],
  adapterEnv: Record<string, string | undefined>,
): void {
  for (const entry of splitToolchainPathPrefix(provisioned.pathPrefix)) {
    binPaths.push(entry);
  }
  Object.assign(adapterEnv, provisioned.envOverlay);
}

export function splitToolchainPathPrefix(pathPrefix: string): string[] {
  return pathPrefix
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

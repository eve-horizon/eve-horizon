import { createConnection, type Socket } from 'node:net';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

export interface TcpIngressListener {
  name: string;
  port: number;
  state: 'pending' | 'provisioning' | 'ready' | string;
  node_target_port?: number | null;
}

export interface TcpIngressService {
  service: string;
  provider: 'none' | 'aws-nlb' | 'klipper' | string;
  hostname?: string | null;
  external_hostname?: string | null;
  external_ip?: string | null;
  listeners: TcpIngressListener[];
}

interface EnvDiagnoseTcpIngressResponse {
  project_id: string;
  env_name: string;
  tcp_ingress?: TcpIngressService[];
}

export interface TcpIngressTarget {
  service: string;
  provider: string;
  listener: TcpIngressListener;
  host: string;
  port: number;
}

interface TcpProbeResult {
  ok: boolean;
  host: string;
  port: number;
  duration_ms: number;
  error?: string;
}

export async function handleTcpIngress(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'test':
      return handleTest(positionals, flags, context, json);
    default:
      throw new Error(
        'Usage: eve tcp-ingress test <project> <env> --listener <name> [--timeout <seconds>] [--json]',
      );
  }
}

async function handleTest(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env']);
  const listenerName = getStringFlag(flags, ['listener']);
  const timeoutSeconds = parseTimeoutSeconds(getStringFlag(flags, ['timeout']), 5);

  if (!projectId || !envName || !listenerName) {
    throw new Error('Usage: eve tcp-ingress test <project> <env> --listener <name> [--timeout <seconds>] [--json]');
  }

  const diagnose = await requestJson<EnvDiagnoseTcpIngressResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/diagnose`,
  );
  const target = resolveTcpIngressTarget(diagnose.tcp_ingress, listenerName);

  if (target.listener.state !== 'ready') {
    const result = {
      ok: false,
      project_id: projectId,
      env_name: envName,
      service: target.service,
      listener: target.listener.name,
      provider: target.provider,
      host: target.host,
      port: target.port,
      state: target.listener.state,
      error: `listener is ${target.listener.state}`,
    };
    if (json) {
      outputJson(result, true);
    } else {
      console.log(`FAIL ${target.host}:${target.port} (${target.service}/${target.listener.name}) - listener is ${target.listener.state}`);
    }
    process.exitCode = 1;
    return;
  }

  const probe = await probeTcp(target.host, target.port, timeoutSeconds * 1000);
  const result = {
    ...probe,
    project_id: projectId,
    env_name: envName,
    service: target.service,
    listener: target.listener.name,
    provider: target.provider,
    state: target.listener.state,
  };

  if (json) {
    outputJson(result, true);
  } else if (probe.ok) {
    console.log(`OK ${target.host}:${target.port} (${target.service}/${target.listener.name}) ${probe.duration_ms}ms`);
  } else {
    console.log(`FAIL ${target.host}:${target.port} (${target.service}/${target.listener.name}) - ${probe.error ?? 'connection failed'}`);
  }

  if (!probe.ok) {
    process.exitCode = 1;
  }
}

export function resolveTcpIngressTarget(
  tcpIngress: TcpIngressService[] | undefined,
  listenerName: string,
): TcpIngressTarget {
  const matches: TcpIngressTarget[] = [];

  for (const entry of tcpIngress ?? []) {
    for (const listener of entry.listeners ?? []) {
      if (listener.name !== listenerName) continue;
      const host = entry.hostname ?? entry.external_hostname ?? entry.external_ip ?? undefined;
      if (!host) {
        throw new Error(`TCP ingress listener "${listenerName}" has no external host yet.`);
      }
      matches.push({
        service: entry.service,
        provider: entry.provider,
        listener,
        host,
        port: listener.port,
      });
    }
  }

  if (matches.length === 0) {
    throw new Error(`TCP ingress listener not found: ${listenerName}`);
  }
  if (matches.length > 1) {
    const services = matches.map((match) => match.service).join(', ');
    throw new Error(`TCP ingress listener "${listenerName}" is ambiguous across services: ${services}`);
  }

  return matches[0];
}

function parseTimeoutSeconds(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  return timeout;
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<TcpProbeResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket;

    const settle = (result: Omit<TcpProbeResult, 'host' | 'port' | 'duration_ms'>) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - started;
      socket.destroy();
      resolve({
        ...result,
        host,
        port,
        duration_ms: durationMs,
      });
    };

    socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle({ ok: true }));
    socket.once('timeout', () => settle({ ok: false, error: `timeout after ${timeoutMs}ms` }));
    socket.once('error', (error) => settle({ ok: false, error: error.message }));
  });
}

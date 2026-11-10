import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { resolveInternalPort } from './internal-port.js';

/**
 * k8s/base runs the API with its internal port on (see internal-port.ts and
 * docs/system/deployment.md): /internal/* answers only there, platform
 * services reach the API through it, and the dashboard, which proxies
 * browser requests, stays on the public port.
 */

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: { configMapKeyRef?: { name: string; key: string } };
};
type Container = {
  name: string;
  env?: EnvVar[];
  envFrom?: Array<{ configMapRef?: { name: string } }>;
  ports?: Array<{ name?: string; containerPort: number }>;
};
type Manifest = {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: any;
};

const baseDir = join(__dirname, '..', '..', '..', '..', 'k8s', 'base');
const manifests: Manifest[] = readdirSync(baseDir)
  .filter((file) => file.endsWith('.yaml'))
  .flatMap((file) =>
    parseAllDocuments(readFileSync(join(baseDir, file), 'utf8'))
      .map((doc) => doc.toJSON() as Manifest | null)
      .filter((doc): doc is Manifest => doc !== null),
  );

function find(kind: string, name: string): Manifest {
  const manifest = manifests.find((m) => m.kind === kind && m.metadata.name === name);
  if (!manifest) throw new Error(`k8s/base has no ${kind} ${name}`);
  return manifest;
}

const clusterConfig = find('ConfigMap', 'eve-cluster-config').data ?? {};
const workloads = manifests.filter((m) => ['Deployment', 'StatefulSet', 'Job'].includes(m.kind));

function containers(workload: Manifest): Container[] {
  return workload.spec?.template?.spec?.containers ?? [];
}

/** EVE_API_URL as the container will see it, or undefined. */
function apiUrlOf(container: Container): string | undefined {
  const entry = container.env?.find((e) => e.name === 'EVE_API_URL');
  if (entry?.value !== undefined) return entry.value;
  const ref = entry?.valueFrom?.configMapKeyRef;
  if (ref) {
    expect(ref.name).toBe('eve-cluster-config');
    return clusterConfig[ref.key];
  }
  if (container.envFrom?.some((source) => source.configMapRef?.name === 'eve-cluster-config')) {
    return clusterConfig.EVE_API_URL;
  }
  return undefined;
}

function envValue(container: Container, name: string): string | undefined {
  return container.env?.find((e) => e.name === name)?.value;
}

const apiContainer = containers(find('Deployment', 'eve-api'))[0]!;
const publicPort = Number(envValue(apiContainer, 'API_PORT'));
const internalPort = resolveInternalPort(envValue(apiContainer, 'EVE_API_INTERNAL_PORT'), publicPort);

/** Workloads whose code calls the API's /internal/* routes. */
const INTERNAL_CALLERS = ['eve-orchestrator', 'eve-worker', 'eve-agent-runtime', 'eve-gateway', 'eve-sso'];

describe('k8s/base API internal port', () => {
  it('turns the internal port on for the API', () => {
    expect(publicPort).toBe(4701);
    expect(internalPort).not.toBeNull();
    expect(apiContainer.ports).toContainEqual({ name: 'internal', containerPort: internalPort });
  });

  it('exposes the internal port on the eve-api Service', () => {
    const ports = find('Service', 'eve-api').spec.ports as Array<{ port: number; targetPort: string | number }>;
    expect(ports).toContainEqual(expect.objectContaining({ port: internalPort, targetPort: 'internal' }));
    expect(ports).toContainEqual(expect.objectContaining({ port: publicPort, targetPort: 'http' }));
  });

  it('keeps the ingress on the public port', () => {
    const ingressPorts = (find('Ingress', 'eve-api').spec.rules as any[]).flatMap((rule) =>
      rule.http.paths.map((path: any) => path.backend.service.port.number),
    );
    expect(ingressPorts).toEqual([publicPort]);
  });

  it('points every platform service that calls /internal/* at the internal port', () => {
    const callers = workloads.filter((w) => w.metadata.name !== 'eve-dashboard' && containers(w).some(apiUrlOf));
    expect(callers.map((w) => w.metadata.name)).toEqual(expect.arrayContaining(INTERNAL_CALLERS));
    for (const workload of callers) {
      for (const container of containers(workload).filter(apiUrlOf)) {
        const url = new URL(apiUrlOf(container)!);
        expect(`${workload.metadata.name}: ${url.hostname}:${url.port}`).toBe(
          `${workload.metadata.name}: eve-api:${internalPort}`,
        );
      }
    }
  });

  it('keeps the dashboard proxy on the public port', () => {
    const url = new URL(apiUrlOf(containers(find('Deployment', 'eve-dashboard'))[0]!)!);
    expect(`${url.hostname}:${url.port}`).toBe(`eve-api:${publicPort}`);
  });
});

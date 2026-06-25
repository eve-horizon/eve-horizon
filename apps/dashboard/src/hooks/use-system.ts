import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SystemService {
  name: string;
  status: string;
  pods?: number;
  ready_pods?: number;
  restarts?: number;
}

export interface SystemPod {
  name: string;
  namespace: string;
  status: string;
  ready: boolean;
  restarts: number;
  age: string;
}

export function useSystemStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: async () => {
      const raw = await api<Record<string, { status: string; ready?: boolean; replicas?: number; version?: string }>>('/system/status');
      const services: SystemService[] = Object.entries(raw).map(([name, svc]) => ({
        name,
        status: svc.status,
        pods: svc.replicas,
        ready_pods: svc.ready ? svc.replicas : 0,
        restarts: undefined,
      }));
      return { services };
    },
    enabled,
    refetchInterval: 10_000,
  });
}

export function useSystemPods(enabled: boolean) {
  return useQuery({
    queryKey: ['system-pods'],
    queryFn: async () => {
      const raw = await api<Array<{ name: string; namespace: string; phase: string; ready: boolean; restarts: number; age: string }>>('/system/pods');
      const pods: SystemPod[] = raw.map((p) => ({
        name: p.name,
        namespace: p.namespace,
        status: p.phase,
        ready: p.ready,
        restarts: p.restarts,
        age: p.age,
      }));
      return { pods };
    },
    enabled,
    refetchInterval: 10_000,
  });
}

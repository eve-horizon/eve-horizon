import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface EnvironmentRecord {
  id: string;
  project_id: string;
  name: string;
  type: string;
  kind?: string;
  namespace: string | null;
  deploy_status?: string;
  status?: string;
  current_release_id: string | null;
  ingress_aliases?: Array<{ alias: string; service_name: string }>;
  created_at: string;
  updated_at: string;
}

interface ProjectEnvsResponse {
  data: EnvironmentRecord[];
  pagination: { total: number; limit: number; offset: number };
}

export function useProjectEnvs(projectId: string | null) {
  return useQuery({
    queryKey: ['project-envs', projectId],
    queryFn: () => api<ProjectEnvsResponse>(`/projects/${projectId}/envs?limit=50`),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });
}

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Project {
  id: string;
  name: string;
  slug: string;
  repo_url?: string;
  org_id: string;
}

export function useProjects(orgId: string | null) {
  return useQuery({
    queryKey: ['projects', orgId],
    queryFn: async () => {
      const res = await api<{ data: Project[] }>(`/projects?org_id=${orgId}&limit=100`);
      return { items: res.data ?? [] };
    },
    enabled: !!orgId,
    staleTime: 60_000,
  });
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

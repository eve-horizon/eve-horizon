import type { Job, JobGitConfig, JobHints } from '@eve/db';

type GateRelevantJob = Pick<Job, 'project_id' | 'env_name' | 'action_type' | 'git_json' | 'hints'>;

function needsBranchGate(gitConfig: JobGitConfig | null): gitConfig is JobGitConfig & { branch: string } {
  return Boolean(
    gitConfig?.branch
      && (
        (gitConfig.push && gitConfig.push !== 'never')
        || (gitConfig.commit && gitConfig.commit !== 'never' && gitConfig.commit !== 'manual')
      ),
  );
}

export function resolveRequiredJobGates(job: GateRelevantJob): string[] {
  const explicitGates = (job.hints as JobHints | undefined)?.gates ?? [];

  // `env_name` scopes API/env resolution for all jobs, but only action jobs
  // should take the exclusive environment lock.
  const envGate = (job.env_name && job.action_type)
    ? [`env:${job.project_id}:${job.env_name}`]
    : [];

  const branchGate = needsBranchGate(job.git_json)
    ? [`git:branch:${job.project_id}:${job.git_json.branch}`]
    : [];

  return [...explicitGates, ...envGate, ...branchGate];
}

export type OrgId = `org_${string}`;
export type ProjectId = `proj_${string}`;
export type JobId = `${ProjectId}:${number}`;
export type AttemptId = `${ProjectId}:${number}:${number}`;
export type ThreadId = `thr_${string}`;
export type ScheduleId = `sched_${string}`;
export type AgentConfigId = `agcfg_${string}`;

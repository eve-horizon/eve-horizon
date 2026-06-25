import { typeid } from 'typeid-js';

export function generateOrgId(): string {
  return typeid('org').toString();
}

export function generateProjectId(): string {
  return typeid('proj').toString();
}

export function generateSecretId(): string {
  return typeid('secr').toString();
}

export function generateEnvironmentId(): string {
  return typeid('env').toString();
}

export function generateReleaseId(): string {
  return typeid('rel').toString();
}

export function generateBuildId(): string {
  return typeid('bld').toString();
}

export function generateBuildRunId(): string {
  return typeid('brun').toString();
}

export function generateBuildArtifactId(): string {
  return typeid('bart').toString();
}

export function generateRateCardId(): string {
  return typeid('rc').toString();
}

export function generateExchangeRateId(): string {
  return typeid('xr').toString();
}

export function generateManifestId(): string {
  return typeid('mnfst').toString();
}

export function generateAgentConfigId(): string {
  return typeid('agcfg').toString();
}

export function generateThreadId(): string {
  return typeid('thr').toString();
}

export function generateScheduleId(): string {
  return typeid('sched').toString();
}

export function generatePipelineRunId(): string {
  return typeid('prun').toString();
}

export function generatePipelineStepRunId(): string {
  return typeid('pstep').toString();
}

export function generateEventId(): string {
  return typeid('evt').toString();
}

export function generateMutationId(): string {
  return typeid('mut').toString();
}

export function generateOrgSyncDeviceId(): string {
  return typeid('fsdev').toString();
}

export function generateOrgSyncLinkId(): string {
  return typeid('fslk').toString();
}

export function generateOrgFsEventId(): string {
  return typeid('fsev').toString();
}

export function generateOrgFsConflictId(): string {
  return typeid('fscf').toString();
}

export function generateOrgFsObjectId(): string {
  return typeid('fsobj').toString();
}

export function generateOrgFsIndexQueueItemId(): string {
  return typeid('queue').toString();
}

export function generateUserId(): string {
  return typeid('user').toString();
}

export function generateIdentityId(): string {
  return typeid('ident').toString();
}

export function generateIntegrationId(): string {
  return typeid('intg').toString();
}

export function generateExternalIdentityId(): string {
  return typeid('exid').toString();
}

export function generateMembershipRequestId(): string {
  return typeid('mreq').toString();
}

export function generateBalanceTransactionId(): string {
  return typeid('bt').toString();
}

export function generateUsageRecordId(): string {
  return typeid('ur').toString();
}

export function generateEnvironmentCostSnapshotId(): string {
  return typeid('ecs').toString();
}

export function generateCloudCostSnapshotId(): string {
  return typeid('ccs').toString();
}

export function generateSweepId(): string {
  return typeid('swp').toString();
}

export function generateAccessRequestId(): string {
  return typeid('areq').toString();
}

export function generateManagedDbInstanceId(): string {
  return typeid('mdbi').toString();
}

export function generateManagedDbTenantId(): string {
  return typeid('mdbt').toString();
}

export function generateManagedDbSnapshotId(): string {
  return typeid('dbsnap').toString();
}

export function generateServicePrincipalId(): string {
  return typeid('sp').toString();
}

export function generateServicePrincipalTokenId(): string {
  return typeid('spt').toString();
}

export function generateAccessRoleId(): string {
  return typeid('role').toString();
}

export function generateAccessBindingId(): string {
  return typeid('bind').toString();
}

export function generateAccessGroupId(): string {
  return typeid('grp').toString();
}

export function generateBatchId(): string {
  return typeid('batch').toString();
}


export function generateIngressAliasId(): string {
  return typeid('ingal').toString();
}

export function generateStorageBucketId(): string {
  return typeid('sbkt').toString();
}

export function generateOrgFsShareId(): string {
  return typeid('share').toString();
}

export function generateOrgFsPublicPathId(): string {
  return typeid('fspub').toString();
}

export function generateIngestId(): string {
  return typeid('ing').toString();
}

export function generatePrivateEndpointId(): string {
  return typeid('ep').toString();
}

export function generateCloudFsMountId(): string {
  return typeid('cfm').toString();
}

export function generateOAuthAppConfigId(): string {
  return typeid('oac').toString();
}

export function generateCustomDomainId(): string {
  return typeid('cdom').toString();
}

export function generateMagicLinkWrapId(): string {
  return typeid('mlw').toString();
}

export function generateAppLinkGrantId(): string {
  return typeid('aplg').toString();
}

export function generateAppLinkSubscriptionId(): string {
  return typeid('apls').toString();
}

export function generateAppLinkEventDeliveryId(): string {
  return typeid('alde').toString();
}

export function formatJobId(projectId: string, jobNumber: number): string {
  return `${projectId}:${jobNumber}`;
}

export function formatAttemptId(projectId: string, jobNumber: number, attemptNumber: number): string {
  return `${projectId}:${jobNumber}:${attemptNumber}`;
}

export function parseJobId(jobId: string): { projectId: string; jobNumber: number } | null {
  const match = jobId.match(/^(proj_[a-zA-Z0-9]+):(\d+)$/);
  if (!match) return null;
  return { projectId: match[1], jobNumber: parseInt(match[2], 10) };
}

export function parseAttemptId(attemptId: string): { projectId: string; jobNumber: number; attemptNumber: number } | null {
  const match = attemptId.match(/^(proj_[a-zA-Z0-9]+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    projectId: match[1],
    jobNumber: parseInt(match[2], 10),
    attemptNumber: parseInt(match[3], 10),
  };
}

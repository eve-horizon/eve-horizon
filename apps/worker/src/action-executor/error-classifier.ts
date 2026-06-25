/**
 * Classify build/deploy errors by matching against known patterns.
 * Returns an error code string used for structured reporting and CLI hints.
 */
export function classifyBuildError(message: string): string {
  if (/authentication|could not read Username|401|403/i.test(message)) return 'auth_error';
  if (/clone failed|git clone|cannot run ssh/i.test(message)) return 'clone_error';
  if (/buildctl failed|dockerfile/i.test(message)) return 'build_error';
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout_error';
  if (/no space|disk quota|ENOSPC/i.test(message)) return 'resource_error';
  if (/registry|push failed|manifest unknown/i.test(message)) return 'registry_error';
  if (/deploy|rollout|replica/i.test(message)) return 'deploy_error';
  return 'unknown_error';
}

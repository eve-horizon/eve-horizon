export type ErrorCode =
  | 'auth_error'
  | 'clone_error'
  | 'build_error'
  | 'timeout_error'
  | 'resource_error'
  | 'registry_error'
  | 'deploy_error'
  | 'unknown_error';

export interface ErrorCodeInfo {
  code: ErrorCode;
  label: string;
  hint: string;
}

export const ERROR_CODES: Record<ErrorCode, ErrorCodeInfo> = {
  auth_error: {
    code: 'auth_error',
    label: 'Authentication Error',
    hint: "Check GITHUB_TOKEN via 'eve secrets set'",
  },
  clone_error: {
    code: 'clone_error',
    label: 'Git Clone Error',
    hint: "Verify repo URL and access. Check 'eve secrets list'",
  },
  build_error: {
    code: 'build_error',
    label: 'Build Error',
    hint: "Run 'eve build diagnose <build_id>' for full output",
  },
  timeout_error: {
    code: 'timeout_error',
    label: 'Timeout Error',
    hint: 'Consider increasing timeout or checking resources',
  },
  resource_error: {
    code: 'resource_error',
    label: 'Resource Error',
    hint: 'Check disk space and memory on build worker',
  },
  registry_error: {
    code: 'registry_error',
    label: 'Registry Error',
    hint: "Check registry credentials via 'eve secrets list'",
  },
  deploy_error: {
    code: 'deploy_error',
    label: 'Deploy Error',
    hint: "Run 'eve env diagnose <project> <env>'",
  },
  unknown_error: {
    code: 'unknown_error',
    label: 'Unknown Error',
    hint: "Run 'eve build diagnose <build_id>' or 'eve job diagnose <job_id>'",
  },
};

/**
 * Look up error code info. Returns unknown_error info for unrecognized codes.
 */
export function getErrorCodeInfo(code: string): ErrorCodeInfo {
  return ERROR_CODES[code as ErrorCode] ?? ERROR_CODES.unknown_error;
}

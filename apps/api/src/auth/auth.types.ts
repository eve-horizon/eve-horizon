import type { AccessBindingScope } from '@eve/shared';

export type AuthUser = {
  user_id: string;
  email?: string;
  role?: string;
  is_admin?: boolean;
  org_id?: string;
  /** Set when the request was made with a job-scoped token */
  is_job_token?: boolean;
  /** The job ID from the token (only set for job tokens) */
  job_id?: string;
  /** The project ID from the token (only set for job/service tokens) */
  project_id?: string;
  /** The agent slug from the token (only set for agent job tokens) */
  agent_slug?: string;
  /** Explicit permissions from job token, service token, or service principal token */
  permissions?: string[];
  /** Optional job-token resource scope. Undefined preserves legacy unscoped job-token behavior. */
  scope?: AccessBindingScope;
  /** Set when the request was made with a service principal token */
  is_service_principal?: boolean;
  /** Set when the request was made with a deployed-service token */
  is_service_token?: boolean;
  /** Set when the request was made with a cross-project app-link token */
  is_app_link_token?: boolean;
  /** The service name from the token (only set for service tokens) */
  service_name?: string;
  /** The environment name from the token (only set for service tokens) */
  env_name?: string;
  /** App-link fields (only set for app-link tokens) */
  subscription_id?: string;
  consumer_project_id?: string;
  producer_project_id?: string;
  consumer_principal?: string;
  consumer_env?: string | null;
  producer_env?: string;
  api_name?: string;
  /** Per-org membership roles (populated for user tokens) */
  memberships?: Array<{ org_id: string; role: string; org_name?: string; org_slug?: string }>;
  /** Redirect URL from a just-applied org invite (used by SSO callback) */
  invite_redirect_to?: string;
  /** Org ID from a just-applied app-scoped invite. */
  invite_org_id?: string;
  /** App context from a just-applied org invite. */
  invite_app_context?: Record<string, unknown> | null;
};

export interface JobTokenPayload {
  sub: string;
  user_id: string;
  org_id: string | null;
  project_id: string;
  job_id: string;
  permissions: string[];
  scope?: AccessBindingScope;
  agent_slug?: string;
  email?: string;
  exp: number;
  iat: number;
  type: 'job';
}

export interface ServiceTokenPayload {
  sub: string;
  org_id: string;
  project_id: string;
  env_name: string;
  service_name: string;
  permissions: string[];
  exp: number;
  iat: number;
  type: 'service';
}

export interface AppLinkTokenPayload {
  sub: string;
  subscription_id: string;
  consumer_project_id: string;
  consumer_org_id: string;
  consumer_principal: string;
  consumer_env: string | null;
  producer_project_id: string;
  producer_env: string;
  api_name: string;
  scopes: string[];
  aud: string;
  exp: number;
  iat: number;
  type: 'app_link';
}

export type BootstrapMode = 'auto-open' | 'recovery' | 'secure' | 'closed';

export interface BootstrapStatus {
  completed: boolean;
  windowOpen: boolean;
  windowClosesAt: Date | null;
  requiresToken: boolean;
  mode: BootstrapMode;
}

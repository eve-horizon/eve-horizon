export interface EveAuthOrg {
  id: string;
  role: 'owner' | 'admin' | 'member';
  name?: string;
  slug?: string;
}

export interface EveUser {
  id: string;
  email: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
  /** True when the user has platform-wide system_admin privileges */
  isAdmin: boolean;
  /** All org memberships for the authenticated user */
  organizations?: EveAuthOrg[];
  /** Project-level role when project context is available */
  projectRole?: 'owner' | 'admin' | 'member' | null;
}

export interface AuthConfig {
  sso_url: string | null;
  eve_api_url: string | null;
  eve_public_api_url: string | null;
  eve_org_id: string | null;
  eve_project_id: string | null;
}

export interface EveAuthState {
  user: EveUser | null;
  loading: boolean;
  error: string | null;
  config: AuthConfig | null;
}

// Server contract types are defined once in @eve-horizon/auth (the packages
// publish in lockstep); re-exported here so existing imports keep working.
export type { EveAppAccess, EveAppAccessOrg } from '@eve-horizon/auth';

export interface EveAppInviteResult {
  status: 'invited' | 'pending' | 'already_member';
  org_id: string;
  email: string;
  role: 'member';
  invite_id?: string;
}

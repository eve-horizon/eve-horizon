export type LoginMethod = 'password_or_magic_link' | 'password' | 'magic_link';

export type ProjectBranding = {
  app_name: string;
  app_logo_url?: string;
  primary_color?: string;
  email_from_name?: string;
  reply_to_email?: string;
  support_email?: string;
  support_url?: string;
};

export type ProjectAuthConfig = {
  login_method: LoginMethod;
  self_signup: boolean;
  invite_requires_password: boolean;
  org_access?: {
    mode: 'project_org' | 'allowlist';
    multi_org: boolean;
    invite_enabled: boolean;
  };
  allowed_redirect_origins?: string[];
};

export type SsoLoginContext = {
  project_id: string;
  org_id: string;
  branding: ProjectBranding | null;
  auth: ProjectAuthConfig | null;
};

export type WrapInspectResponse =
  | {
      found: true;
      kind: 'magic_link' | 'invite';
      project_id: string | null;
      org_id: string | null;
      redirect_to: string | null;
      expires_at: string;
      expired: boolean;
      consumed: boolean;
      get_count: number;
    }
  | { found: false };

export type WrapConsumeResponse =
  | {
      status: 'ok';
      gotrue_action_link: string;
      kind: 'magic_link' | 'invite';
      project_id: string | null;
      org_id: string | null;
    }
  | { status: 'expired' | 'already_consumed' | 'unknown' };

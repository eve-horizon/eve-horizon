import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { FlagValue } from './args';
import { getStringFlag } from './args';
import type { CredentialsFile, ProfileConfig } from './config';

export type ResolvedContext = {
  apiUrl: string;
  orgId?: string;
  projectId?: string;
  profileName: string;
  profile: ProfileConfig;
  authKey: string;
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Where the profile was resolved from */
  profileSource: 'flag' | 'env' | 'local' | 'default';
};

export type RepoProfilesFile = {
  active_profile?: string;
  profiles?: Record<string, ProfileConfig>;
  /** Legacy single-profile fields (pre local-profile refactor) */
  profile?: string;
  api_url?: string;
  org_id?: string;
  project_id?: string;
  default_harness?: string;
  supabase_url?: string;
  supabase_anon_key?: string;
  default_email?: string;
  default_ssh_key?: string;
};

export type RepoProfiles = {
  activeProfile?: string;
  profiles: Record<string, ProfileConfig>;
};

const DEFAULT_PROFILE = 'default';
// Default to staging so `eve` works out-of-the-box for new users.
// Local developers override via EVE_API_URL or profile api_url.
export const DEFAULT_API_URL = 'https://api.eve.example.com';

/**
 * Get the path to the repo profile file
 */
export function getRepoProfilePath(): string {
  return join(process.cwd(), '.eve', 'profile.yaml');
}

/**
 * Load repository profiles from .eve/profile.yaml if it exists
 */
export function loadRepoProfiles(): RepoProfiles {
  const profilePath = getRepoProfilePath();

  if (!existsSync(profilePath)) {
    return { profiles: {} };
  }

  try {
    const content = readFileSync(profilePath, 'utf-8');
    const parsed = parseYaml(content);
    return normalizeRepoProfiles(parsed as RepoProfilesFile | null);
  } catch {
    // Silently ignore parse errors
    return { profiles: {} };
  }
}

/**
 * Save repository profiles to .eve/profile.yaml
 */
export function saveRepoProfiles(repoProfiles: RepoProfiles): void {
  const profilePath = getRepoProfilePath();
  const dir = dirname(profilePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const payload = {
    active_profile: repoProfiles.activeProfile,
    profiles: repoProfiles.profiles,
  };
  writeFileSync(profilePath, stringifyYaml(payload));
}

/**
 * Remove repository profile file
 */
export function removeRepoProfile(): boolean {
  const profilePath = getRepoProfilePath();

  if (!existsSync(profilePath)) {
    return false;
  }

  unlinkSync(profilePath);
  return true;
}

export function resolveContext(
  flags: Record<string, FlagValue>,
  credentials: CredentialsFile,
): ResolvedContext {
  const repoProfiles = loadRepoProfiles();
  const profileNames = Object.keys(repoProfiles.profiles);

  // Determine profile name and source
  // Priority: flag > env > local (.eve/profile.yaml) > default
  let profileName: string;
  let profileSource: 'flag' | 'env' | 'local' | 'default';

  const flagProfile = getStringFlag(flags, ['profile']);
  const envProfile = process.env.EVE_PROFILE;
  const localProfile = repoProfiles.activeProfile;

  if (flagProfile) {
    profileName = flagProfile;
    profileSource = 'flag';
  } else if (envProfile) {
    profileName = envProfile;
    profileSource = 'env';
  } else if (localProfile) {
    profileName = localProfile;
    profileSource = 'local';
  } else if (profileNames.length === 1) {
    profileName = profileNames[0];
    profileSource = 'local';
  } else if (profileNames.includes(DEFAULT_PROFILE)) {
    profileName = DEFAULT_PROFILE;
    profileSource = 'local';
  } else if (profileNames.length > 0) {
    profileName = profileNames[0];
    profileSource = 'local';
  } else {
    profileName = DEFAULT_PROFILE;
    profileSource = 'default';
  }

  // Get base profile config from local profiles
  const profile = repoProfiles.profiles[profileName] ?? {};

  const apiUrl =
    getStringFlag(flags, ['api', 'api-url']) ||
    process.env.EVE_API_URL ||
    profile.api_url ||
    DEFAULT_API_URL;
  const orgId =
    getStringFlag(flags, ['org']) ||
    process.env.EVE_ORG_ID ||
    profile.org_id;
  const projectId =
    getStringFlag(flags, ['project']) ||
    process.env.EVE_PROJECT_ID ||
    profile.project_id;

  const authKey = toAuthKey(apiUrl);
  const tokenEntry = credentials.tokens[authKey] || credentials.profiles?.[profileName];

  // Token priority: EVE_JOB_TOKEN (job context) > credentials file
  // EVE_JOB_TOKEN is set by the script executor when running CLI commands
  // inside pipeline steps (e.g., eve db migrate during deploy)
  const jobToken = process.env.EVE_JOB_TOKEN;

  return {
    apiUrl,
    orgId,
    projectId,
    profileName,
    profile,
    authKey,
    token: jobToken || tokenEntry?.access_token,
    refreshToken: jobToken ? undefined : tokenEntry?.refresh_token,
    expiresAt: jobToken ? undefined : tokenEntry?.expires_at,
    profileSource,
  };
}

/**
 * Parse a harness spec like "mclaude" or "mclaude:fast" into [harness, variant]
 */
export function parseHarnessSpec(spec: string | undefined): [string | undefined, string | undefined] {
  if (!spec) return [undefined, undefined];
  const colonIdx = spec.indexOf(':');
  if (colonIdx === -1) return [spec, undefined];
  return [spec.slice(0, colonIdx), spec.slice(colonIdx + 1) || undefined];
}

/**
 * Build a ResolvedContext for a specific named profile without flag/env resolution.
 * Used by `eve project status` to iterate all profiles.
 */
export function resolveContextForProfile(
  profileName: string,
  profile: ProfileConfig,
  credentials: CredentialsFile,
): ResolvedContext {
  const apiUrl = profile.api_url || DEFAULT_API_URL;
  const authKey = toAuthKey(apiUrl);
  const tokenEntry = credentials.tokens[authKey] || credentials.profiles?.[profileName];

  return {
    apiUrl,
    orgId: profile.org_id,
    projectId: profile.project_id,
    profileName,
    profile,
    authKey,
    token: tokenEntry?.access_token,
    refreshToken: tokenEntry?.refresh_token,
    expiresAt: tokenEntry?.expires_at,
    profileSource: 'local',
  };
}

function normalizeRepoProfiles(parsed: RepoProfilesFile | null): RepoProfiles {
  if (!parsed || typeof parsed !== 'object') {
    return { profiles: {} };
  }

  if (parsed.profiles && typeof parsed.profiles === 'object') {
    return {
      activeProfile: parsed.active_profile,
      profiles: parsed.profiles as Record<string, ProfileConfig>,
    };
  }

  const legacyConfig = extractProfileConfig(parsed);
  const hasLegacyFields = Object.keys(legacyConfig).length > 0;
  const legacyName = parsed.profile ?? parsed.active_profile;

  if (!hasLegacyFields && !legacyName) {
    return { profiles: {} };
  }

  const name = legacyName ?? DEFAULT_PROFILE;
  return {
    activeProfile: name,
    profiles: { [name]: legacyConfig },
  };
}

function extractProfileConfig(raw: RepoProfilesFile): ProfileConfig {
  const config: ProfileConfig = {};
  if (raw.api_url) config.api_url = raw.api_url;
  if (raw.org_id) config.org_id = raw.org_id;
  if (raw.project_id) config.project_id = raw.project_id;
  if (raw.default_harness) config.default_harness = raw.default_harness;
  if (raw.supabase_url) config.supabase_url = raw.supabase_url;
  if (raw.supabase_anon_key) config.supabase_anon_key = raw.supabase_anon_key;
  if (raw.default_email) config.default_email = raw.default_email;
  if (raw.default_ssh_key) config.default_ssh_key = raw.default_ssh_key;
  return config;
}

function toAuthKey(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '');
}

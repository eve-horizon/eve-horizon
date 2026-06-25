import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ProfileConfig = {
  api_url?: string;
  org_id?: string;
  project_id?: string;
  supabase_url?: string;
  supabase_anon_key?: string;
  /** Default harness, optionally with variant: "mclaude" or "mclaude:fast" */
  default_harness?: string;
  /** Default email for auth login */
  default_email?: string;
  /** Default SSH key path for auth login */
  default_ssh_key?: string;
};

export type TokenEntry = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
};

export type CredentialsFile = {
  /** Token entries keyed by auth scope (e.g., api_url) */
  tokens: Record<string, TokenEntry>;
  /** Legacy profile-keyed tokens (pre local-profile refactor) */
  profiles?: Record<string, TokenEntry>;
};

const CONFIG_DIR = join(homedir(), '.eve');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${(error as Error).message}`);
  }
}

function writeJsonFile(path: string, value: unknown): void {
  ensureConfigDir();
  writeFileSync(path, JSON.stringify(value, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort for platforms that don't support chmod.
  }
}

export function loadCredentials(): CredentialsFile {
  const fallback: CredentialsFile = { tokens: {} };
  const credentials = readJsonFile(CREDENTIALS_PATH, fallback);
  credentials.tokens = credentials.tokens ?? {};
  credentials.profiles = credentials.profiles ?? {};
  return credentials;
}

export function saveCredentials(credentials: CredentialsFile): void {
  credentials.tokens = credentials.tokens ?? {};
  credentials.profiles = credentials.profiles ?? {};
  writeJsonFile(CREDENTIALS_PATH, credentials);
}

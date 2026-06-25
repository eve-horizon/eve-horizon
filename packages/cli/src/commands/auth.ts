import type { FlagValue } from '../lib/args';
import { getStringFlag, getBooleanFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import type { CredentialsFile } from '../lib/config';
import { saveCredentials } from '../lib/config';
import { requestRaw, requestJson, unwrapListResponse } from '../lib/client';
import { outputJson } from '../lib/output';
import { resolveCodexAuthForSync } from '../lib/codex-auth';
import type { CodexAuthValidation } from '../lib/codex-auth';
import { readClaudeApiKeySource } from '@eve/shared';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';

type AuthStatus = {
  auth_enabled: boolean;
  authenticated: boolean;
  user_id?: string;
  email?: string;
  role?: string;
  is_admin?: boolean;
  memberships?: Array<{ org_id: string; role: string }>;
};

export async function handleAuth(
  subcommand: string | undefined,
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  credentials: CredentialsFile,
): Promise<void> {
  const json = Boolean(flags.json);
  const noInteractive = getBooleanFlag(flags, ['no-interactive']) ?? false;

  switch (subcommand) {
    case 'login': {
      const status = await requestRaw(context, '/auth/me', { allowError: true, tokenOverride: '' });
      if (status.ok) {
        const data = status.data as AuthStatus;
        if (data.auth_enabled === false) {
          outputJson(data, json, 'Auth disabled for this stack; login not required.');
          return;
        }
      }

      const email = getStringFlag(flags, ['email']) ?? process.env.EVE_AUTH_EMAIL ?? context.profile.default_email;
      const userId = getStringFlag(flags, ['user-id']);
      const password = getStringFlag(flags, ['password']) ?? process.env.EVE_AUTH_PASSWORD;

      const ttlStr = getStringFlag(flags, ['ttl']);
      const ttlDays = ttlStr ? parseInt(ttlStr, 10) : undefined;
      if (ttlDays !== undefined && (isNaN(ttlDays) || ttlDays < 1 || ttlDays > 90)) {
        throw new Error('--ttl must be between 1 and 90 days');
      }

      const supabaseUrl =
        getStringFlag(flags, ['supabase-url']) ||
        process.env.EVE_SUPABASE_URL ||
        context.profile.supabase_url;
      const supabaseAnonKey =
        getStringFlag(flags, ['supabase-anon-key']) ||
        process.env.EVE_SUPABASE_ANON_KEY ||
        context.profile.supabase_anon_key;

      const useSupabase = Boolean(password);

      if (useSupabase) {
        if (!email || !password) {
          throw new Error('Usage: eve auth login --email <email> --password <password>');
        }

        if (!supabaseUrl || !supabaseAnonKey) {
          throw new Error('Missing Supabase config. Provide --supabase-url and --supabase-anon-key.');
        }

        const loginResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
          body: JSON.stringify({ email, password }),
        });

        const loginText = await loginResponse.text();
        let loginData: unknown = null;
        if (loginText) {
          try {
            loginData = JSON.parse(loginText);
          } catch {
            loginData = loginText;
          }
        }

        if (!loginResponse.ok || !loginData || typeof loginData !== 'object') {
          throw new Error(`Supabase login failed: ${loginText}`);
        }

        const payload = loginData as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          token_type?: string;
        };
        if (!payload.access_token) {
          throw new Error('Supabase login response missing access_token');
        }

        const expiresAt = payload.expires_in
          ? Math.floor(Date.now() / 1000) + payload.expires_in
          : undefined;

        credentials.tokens[context.authKey] = {
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
          expires_at: expiresAt,
          token_type: payload.token_type,
        };
        saveCredentials(credentials);
        outputJson({ profile: context.profileName, token_type: payload.token_type }, json, '✓ Logged in');
        return;
      }

      if (!email && !userId) {
        throw new Error('Usage: eve auth login --email <email> or --user-id <id>');
      }

      // Attempt SSH key login with GitHub key auto-discovery on failure
      const loginResult = await attemptSshLogin(context, credentials, flags, email, userId, ttlDays);

      if (loginResult.success) {
        outputJson({ profile: context.profileName, token_type: loginResult.tokenType }, json, '✓ Logged in');
        return;
      }

      // Check if this is a verification failure that could benefit from key registration
      const isVerificationFailure = loginResult.error && (
        loginResult.error.includes('Signature verification failed') ||
        loginResult.error.includes('No matching identity') ||
        loginResult.error.includes('Identity not found') ||
        loginResult.error.includes('Public key not registered')
      );

      if (!isVerificationFailure || noInteractive || json) {
        throw new Error(loginResult.error ?? 'Auth verify failed');
      }

      // Offer GitHub key auto-discovery
      const registered = await offerGitHubKeyRegistration(context, email);

      if (!registered) {
        throw new Error(loginResult.error ?? 'Auth verify failed');
      }

      // Retry login after key registration
      console.log('\nRetrying login with registered keys...');
      const retryResult = await attemptSshLogin(context, credentials, flags, email, userId, ttlDays);

      if (retryResult.success) {
        outputJson({ profile: context.profileName, token_type: retryResult.tokenType }, json, '✓ Logged in');
        return;
      }

      throw new Error(retryResult.error ?? 'Auth verify failed after key registration');
    }
    case 'logout': {
      const hadToken = Boolean(
        credentials.tokens[context.authKey] || credentials.profiles?.[context.profileName],
      );
      if (credentials.tokens[context.authKey]) {
        delete credentials.tokens[context.authKey];
      }
      if (credentials.profiles?.[context.profileName]) {
        delete credentials.profiles[context.profileName];
      }
      if (hadToken) {
        saveCredentials(credentials);
      }
      outputJson({ profile: context.profileName }, json, '✓ Logged out');
      return;
    }
    case 'status':
    case 'whoami': {
      const response = await requestRaw(context, '/auth/me', { allowError: true });
      if (!response.ok) {
        outputJson({ auth_enabled: true, authenticated: false }, json, 'Not authenticated');
        return;
      }
      const data = response.data as AuthStatus & { permissions?: string[] };
      if (data.auth_enabled === false) {
        outputJson(data, json, 'Auth disabled for this stack.');
        return;
      }
      if (!json && data.permissions && data.permissions.length > 0) {
        console.log(`User: ${data.user_id ?? 'unknown'} (${data.email ?? 'no email'})`);

        // Resolve role from memberships for the active profile org
        let displayRole = data.role ?? 'member';
        if (context.orgId && data.memberships?.length) {
          const match = data.memberships.find(m => m.org_id === context.orgId);
          if (match) displayRole = match.role;
        }
        console.log(`Role: ${displayRole}`);
        console.log(`Admin: ${data.is_admin ?? false}`);

        if (context.orgId && data.memberships?.length) {
          console.log(`\nOrg memberships:`);
          for (const m of data.memberships) {
            const marker = m.org_id === context.orgId ? ' (active)' : '';
            console.log(`  ${m.org_id}: ${m.role}${marker}`);
          }
        }

        console.log(`\nPermissions (${data.permissions.length}):`);
        for (const perm of data.permissions) {
          console.log(`  ${perm}`);
        }
        return;
      }
      outputJson(data, json);
      return;
    }
    case 'permissions': {
      type PermissionMatrix = {
        matrix: Array<{ permission: string; member: boolean; admin: boolean; owner: boolean }>;
      };
      const response = await requestJson<PermissionMatrix>(context, '/auth/permissions');
      if (json) {
        outputJson(response, json);
        return;
      }
      console.log('Permission Matrix:');
      console.log('');
      const header = 'Permission'.padEnd(24) + 'Member'.padEnd(10) + 'Admin'.padEnd(10) + 'Owner';
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const row of response.matrix) {
        const m = row.member ? '✓' : '-';
        const a = row.admin ? '✓' : '-';
        const o = row.owner ? '✓' : '-';
        console.log(`${row.permission.padEnd(24)}${m.padEnd(10)}${a.padEnd(10)}${o}`);
      }
      return;
    }
    case 'bootstrap': {
      const statusOnly = getBooleanFlag(flags, ['status']) ?? false;

      // Check bootstrap status first
      const statusResponse = await requestRaw(context, '/auth/bootstrap/status', {
        allowError: true,
        tokenOverride: '',
      });

      type BootstrapStatus = {
        completed: boolean;
        window_open: boolean;
        window_closes_at: string | null;
        requires_token: boolean;
        mode: string;
      };

      let status: BootstrapStatus | null = null;
      if (statusResponse.ok) {
        status = statusResponse.data as BootstrapStatus;
      }

      // Handle --status subcommand
      if (statusOnly) {
        if (!status) {
          throw new Error('Failed to fetch bootstrap status');
        }

        if (json) {
          outputJson(status, json);
          return;
        }

        console.log('Bootstrap Status:');
        console.log(`  Mode: ${status.mode}`);
        if (status.completed) {
          console.log('  Status: completed');
        } else if (status.window_open) {
          const closesAt = status.window_closes_at ? new Date(status.window_closes_at) : null;
          const remaining = closesAt ? Math.max(0, Math.round((closesAt.getTime() - Date.now()) / 60000)) : null;
          console.log(`  Window: open${remaining !== null ? ` (closes in ${remaining} minutes)` : ''}`);
        } else {
          console.log('  Window: closed');
        }
        console.log(`  Token required: ${status.requires_token ? 'yes' : 'no'}`);
        return;
      }

      const email = getStringFlag(flags, ['email']);
      const token = getStringFlag(flags, ['token']) ?? process.env.EVE_BOOTSTRAP_TOKEN;
      const sshKeyPath =
        getStringFlag(flags, ['ssh-key']) ??
        join(homedir(), '.ssh', 'id_ed25519.pub');
      const displayName = getStringFlag(flags, ['display-name']);

      if (!email) {
        throw new Error('Usage: eve auth bootstrap --email <email> [--token <token>] [--ssh-key <path>] [--display-name <name>]');
      }

      // Check status and handle accordingly
      if (status) {
        if (status.completed) {
          // In non-production/dev stacks the API may still return an existing admin token.
          console.log('Bootstrap already completed. Attempting server-side recovery flow.');
        }

        if (!status.completed && !status.requires_token && status.window_open) {
          console.log(`Bootstrap window open (${status.mode} mode). Token not required.`);
        } else if (!status.completed && status.requires_token && !token) {
          throw new Error('Bootstrap token required. Use --token <token> or set EVE_BOOTSTRAP_TOKEN');
        }
      } else if (!token) {
        // Could not fetch status, require token as fallback
        throw new Error('Bootstrap token required. Use --token <token> or set EVE_BOOTSTRAP_TOKEN');
      }

      // Read SSH public key
      if (!existsSync(sshKeyPath)) {
        throw new Error(`SSH public key not found: ${sshKeyPath}`);
      }
      const publicKey = readFileSync(sshKeyPath, 'utf8').trim();

      // POST to /auth/bootstrap
      const bootstrapResponse = await requestRaw(context, '/auth/bootstrap', {
        method: 'POST',
        body: {
          token: token ?? undefined,
          email,
          public_key: publicKey,
          display_name: displayName,
        },
      });

      if (!bootstrapResponse.ok) {
        const message = typeof bootstrapResponse.data === 'string'
          ? bootstrapResponse.data
          : bootstrapResponse.text;
        throw new Error(`Bootstrap failed: ${message}`);
      }

      const payload = bootstrapResponse.data as {
        access_token?: string;
        token_type?: string;
        expires_at?: number;
        user_id?: string;
      };

      if (!payload.access_token) {
        throw new Error('Bootstrap response missing access_token');
      }

      credentials.tokens[context.authKey] = {
        access_token: payload.access_token,
        expires_at: payload.expires_at,
        token_type: payload.token_type,
      };
      saveCredentials(credentials);
      outputJson(
        { profile: context.profileName, user_id: payload.user_id, token_type: payload.token_type },
        json,
        `✓ Bootstrapped admin user (user_id: ${payload.user_id})`
      );
      return;
    }
    case 'token': {
      // Print the current access token to stdout for use in scripts
      const tokenEntry =
        credentials.tokens[context.authKey] || credentials.profiles?.[context.profileName];
      if (!tokenEntry || !tokenEntry.access_token) {
        console.error('No valid token found. Please login first with: eve auth login');
        process.exit(1);
      }

      // Print only the token to stdout, nothing else
      console.log(tokenEntry.access_token);
      return;
    }
    case 'mint': {
      const email = getStringFlag(flags, ['email']);
      const orgId = getStringFlag(flags, ['org']);
      const projectId = getStringFlag(flags, ['project']);
      const role = getStringFlag(flags, ['role']) ?? 'member';

      const ttlStr = getStringFlag(flags, ['ttl']);
      const ttlDays = ttlStr ? parseInt(ttlStr, 10) : undefined;
      if (ttlDays !== undefined && (isNaN(ttlDays) || ttlDays < 1 || ttlDays > 90)) {
        throw new Error('--ttl must be between 1 and 90 days');
      }

      if (!email) {
        throw new Error('Usage: eve auth mint --email <email> [--org <org_id> | --project <project_id>] [--role <role>]');
      }

      if (!orgId && !projectId) {
        throw new Error('Usage: eve auth mint --email <email> [--org <org_id> | --project <project_id>] [--role <role>]');
      }

      if (!['owner', 'admin', 'member'].includes(role)) {
        throw new Error(`Invalid role: ${role}. Must be one of: owner, admin, member`);
      }

      type MintResponse = {
        access_token: string;
        token_type?: string;
        expires_at?: number;
        user_id?: string;
        created?: boolean;
        org_id?: string;
        project_id?: string | null;
        role?: string;
      };

      const response = await requestJson<MintResponse>(context, '/auth/mint', {
        method: 'POST',
        body: {
          email,
          org_id: orgId,
          project_id: projectId,
          role,
          ttl_days: ttlDays,
        },
      });

      if (json) {
        outputJson(response, json);
        return;
      }

      if (!response.access_token) {
        throw new Error('Mint response missing access_token');
      }

      // Print only the token to stdout, nothing else
      console.log(response.access_token);
      return;
    }
    case 'sync': {
      const claudeOnly = getBooleanFlag(flags, ['claude']) ?? false;
      const codexOnly = getBooleanFlag(flags, ['codex']) ?? false;
      const dryRun = getBooleanFlag(flags, ['dry-run']) ?? false;
      const orgIdFlag = getStringFlag(flags, ['org']);
      const projectIdFlag = getStringFlag(flags, ['project']);

      // Determine scope: project > org > user (default)
      type SecretScope = { type: 'user'; userId: string } | { type: 'org'; orgId: string } | { type: 'project'; projectId: string };
      let scope: SecretScope;

      if (projectIdFlag) {
        scope = { type: 'project', projectId: projectIdFlag };
      } else if (orgIdFlag) {
        scope = { type: 'org', orgId: orgIdFlag };
      } else {
        // Default to user scope - need to fetch user ID
        const meResponse = await requestRaw(context, '/auth/me', { allowError: true });
        if (!meResponse.ok) {
          throw new Error('Not authenticated. Run "eve auth login" first.');
        }
        const meData = meResponse.data as AuthStatus;
        if (!meData.user_id) {
          throw new Error('Could not determine user ID. Try specifying --org or --project instead.');
        }
        scope = { type: 'user', userId: meData.user_id };
      }

      const extractClaude = !codexOnly; // Extract Claude unless --codex is specified
      const extractCodex = !claudeOnly; // Extract Codex unless --claude is specified

      const extractedTokens: Record<string, string> = {};
      const platform = process.platform;
      const warnings: string[] = [];

      // Extract Claude OAuth tokens
      if (extractClaude) {
        // Try macOS Keychain first
        if (platform === 'darwin') {
          for (const service of ['Claude Code-credentials', 'anthropic.claude']) {
            try {
              const output = execSync(
                `security find-generic-password -s "${service}" -w`,
                { encoding: 'utf8' }
              ).trim();
              if (output) {
                // Newer Claude Code stores a JSON blob in keychain (claudeAiOauth.accessToken).
                // Keep backwards compatibility for plain-string tokens.
                let token = output;
                try {
                  const parsed = JSON.parse(output) as Record<string, unknown>;
                  const claudeOauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
                  const accessToken = claudeOauth?.accessToken;
                  if (typeof accessToken === 'string' && accessToken.length > 0) {
                    token = accessToken;
                  } else if (typeof (parsed as any).accessToken === 'string') {
                    token = (parsed as any).accessToken as string;
                  }
                } catch {
                  // Not JSON; assume output is the token.
                }
                extractedTokens.CLAUDE_CODE_OAUTH_TOKEN = token;
                break;
              }
            } catch {
              // Token not found in keychain, continue
            }
          }
        }

        // Check credential files (all platforms)
        if (!extractedTokens.CLAUDE_CODE_OAUTH_TOKEN) {
          const credentialPaths = [
            `${homedir()}/.claude/.credentials.json`,
            `${homedir()}/.claude/credentials.json`,
            `${homedir()}/.config/claude/credentials.json`,
          ];

          for (const credPath of credentialPaths) {
            if (existsSync(credPath)) {
              try {
                const content = readFileSync(credPath, 'utf8');
                const creds = JSON.parse(content) as Record<string, unknown>;
                // Handle nested claudeAiOauth format (current Claude Code format)
                const claudeOauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
                if (claudeOauth?.accessToken) {
                  extractedTokens.CLAUDE_CODE_OAUTH_TOKEN = claudeOauth.accessToken as string;
                  break;
                }
                // Fallback to legacy root-level tokens
                if (creds.oauth_token || creds.access_token) {
                  extractedTokens.CLAUDE_CODE_OAUTH_TOKEN = (creds.oauth_token || creds.access_token) as string;
                  break;
                }
              } catch {
                // Failed to parse, continue
              }
            }
          }
        }
      }

      // Extract Codex/Code OAuth tokens
      if (extractCodex) {
        // Try macOS Keychain first
        if (platform === 'darwin') {
          for (const service of ['openai.codex', 'Code-credentials']) {
            try {
              const output = execSync(
                `security find-generic-password -s "${service}" -w`,
                { encoding: 'utf8' }
              ).trim();
              if (output) {
                // Some installs store JSON in keychain; prefer tokens.access_token when present.
                let token = output;
                try {
                  const parsed = JSON.parse(output) as Record<string, unknown>;
                  const tokens = parsed.tokens as Record<string, unknown> | undefined;
                  const accessToken = tokens?.access_token ?? (parsed as any).access_token ?? (parsed as any).accessToken;
                  if (typeof accessToken === 'string' && accessToken.length > 0) {
                    token = accessToken;
                  }
                } catch {
                  // Not JSON; assume output is the token.
                }
                extractedTokens.CODEX_OAUTH_ACCESS_TOKEN = token;
                break;
              }
            } catch {
              // Token not found in keychain, continue
            }
          }
        }

        // Check auth files (all platforms): ~/.codex/auth.json and ~/.code/auth.json.
        // Validate refresh usability before syncing CODEX_AUTH_JSON_B64 so workers
        // do not inherit credentials that are already known to fail at runtime.
        const codexValidation = await resolveCodexAuthForSync({
          validateRefresh: true,
          persistRefresh: true,
        });
        if (codexValidation.usable) {
          if (codexValidation.authJsonB64) {
            extractedTokens.CODEX_AUTH_JSON_B64 = codexValidation.authJsonB64;
          }
          if (codexValidation.accessToken) {
            extractedTokens.CODEX_OAUTH_ACCESS_TOKEN = codexValidation.accessToken;
          }
          if (codexValidation.apiKey) {
            extractedTokens.OPENAI_API_KEY = codexValidation.apiKey;
          }
          if (codexValidation.refreshed) {
            warnings.push(`Codex auth.json refreshed locally during validation: ${codexValidation.candidate?.sourcePath.replace(homedir(), '~') ?? 'auth.json'}`);
          }
        } else if (codexValidation.found) {
          throw new Error(formatCodexAuthValidationError(codexValidation));
        }
      }

      if (Object.keys(extractedTokens).length === 0) {
        outputJson(
          { extracted: 0, tokens: [] },
          json,
          'No tokens found on host machine'
        );
        return;
      }

      // Check Claude token type and warn if short-lived OAuth token
      const claudeToken = extractedTokens.CLAUDE_CODE_OAUTH_TOKEN;
      if (claudeToken && !claudeToken.startsWith('sk-ant-oat01-')) {
        warnings.push('Found short-lived Claude OAuth token (expires in ~15h). For reliable agent execution, generate a long-lived token: claude setup-token\nThen re-run: eve auth sync');
        if (!json) {
          process.stderr.write(`⚠  Found short-lived Claude OAuth token (expires in ~15h).\n   For reliable agent execution, generate a long-lived token: claude setup-token\n   Then re-run: eve auth sync\n\n`);
        }
      }

      // Build target label for output
      const targetLabel = scope.type === 'user' ? 'user' :
        scope.type === 'org' ? `org ${scope.orgId}` :
        `project ${scope.projectId}`;

      if (dryRun) {
        const tokenList = Object.keys(extractedTokens).map(key => ({
          name: key,
          value: `${extractedTokens[key].substring(0, 10)}...`,
        }));
        outputJson(
          { dry_run: true, would_set: tokenList, target: targetLabel, scope, warnings },
          json,
          `Would set ${tokenList.length} token(s) on ${targetLabel}:\n${tokenList.map(t => `  - ${t.name}`).join('\n')}`
        );
        return;
      }

      // Set secrets via API - endpoint depends on scope
      const endpoint = scope.type === 'user' ? `/users/${scope.userId}/secrets` :
        scope.type === 'org' ? `/orgs/${scope.orgId}/secrets` :
        `/projects/${scope.projectId}/secrets`;

      const results: Array<{ name: string; success: boolean; error?: string }> = [];

      for (const [name, value] of Object.entries(extractedTokens)) {
        try {
          await requestJson(context, endpoint, {
            method: 'POST',
            body: {
              key: name,
              value,
            },
          });
          results.push({ name, success: true });
        } catch (error) {
          results.push({
            name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      outputJson(
        {
          target: targetLabel,
          scope,
          results,
          success: successCount,
          failed: failCount,
          warnings,
        },
        json,
        `✓ Set ${successCount} secret(s) on ${targetLabel}${failCount > 0 ? ` (${failCount} failed)` : ''}`
      );
      return;
    }
    case 'creds': {
      // Show local credential status without syncing
      const claudeOnly = getBooleanFlag(flags, ['claude']) ?? false;
      const codexOnly = getBooleanFlag(flags, ['codex']) ?? false;

      const checkClaude = !codexOnly;
      const checkCodex = !claudeOnly;

      type CredentialInfo = {
        name: string;
        source: string;
        found: boolean;
        usable?: boolean;
        preview?: string;
        expiresAt?: string;
        tokenType?: string;
        lastRefresh?: string;
        accessTokenValid?: boolean;
        refreshTokenPresent?: boolean;
        refreshTokenUsable?: boolean;
        validationStatus?: string;
        error?: string;
        action?: string;
      };

      const credentials: CredentialInfo[] = [];
      const plat = process.platform;

      // Check Claude credentials
      if (checkClaude) {
        let claudeFound = false;
        let claudeSource = '';
        let claudePreview = '';
        let claudeExpires: string | undefined;
        let claudeTokenType: string | undefined;

        // Try macOS Keychain
        if (plat === 'darwin' && !claudeFound) {
          for (const service of ['Claude Code-credentials', 'anthropic.claude']) {
            try {
              const output = execSync(
                `security find-generic-password -s "${service}" -w`,
                { encoding: 'utf8' }
              ).trim();
              if (output) {
                claudeFound = true;
                claudeSource = `macOS Keychain (${service})`;
                // Try to extract the actual token value for prefix detection
                let tokenStr = output;
                try {
                  const parsed = JSON.parse(output) as Record<string, unknown>;
                  const claudeOauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
                  if (typeof claudeOauth?.accessToken === 'string') tokenStr = claudeOauth.accessToken;
                } catch { /* not JSON */ }
                claudeTokenType = tokenStr.startsWith('sk-ant-oat01-') ? 'setup-token' : 'oauth';
                claudePreview = tokenStr.substring(0, 15) + '...';
                break;
              }
            } catch {
              // Not found
            }
          }
        }

        // Check credential files
        if (!claudeFound) {
          const credentialPaths = [
            `${homedir()}/.claude/.credentials.json`,
            `${homedir()}/.claude/credentials.json`,
            `${homedir()}/.config/claude/credentials.json`,
          ];

          for (const credPath of credentialPaths) {
            if (existsSync(credPath)) {
              try {
                const content = readFileSync(credPath, 'utf8');
                const creds = JSON.parse(content) as Record<string, unknown>;
                const claudeOauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
                if (claudeOauth?.accessToken) {
                  claudeFound = true;
                  claudeSource = credPath.replace(homedir(), '~');
                  const tokenStr = claudeOauth.accessToken as string;
                  claudePreview = tokenStr.substring(0, 15) + '...';
                  claudeTokenType = tokenStr.startsWith('sk-ant-oat01-') ? 'setup-token' : 'oauth';
                  if (claudeOauth.expiresAt) {
                    const expDate = new Date(claudeOauth.expiresAt as number);
                    claudeExpires = expDate.toISOString();
                  }
                  break;
                }
                if (creds.oauth_token || creds.access_token) {
                  claudeFound = true;
                  claudeSource = credPath.replace(homedir(), '~');
                  const token = (creds.oauth_token || creds.access_token) as string;
                  claudePreview = token.substring(0, 15) + '...';
                  claudeTokenType = token.startsWith('sk-ant-oat01-') ? 'setup-token' : 'oauth';
                  break;
                }
              } catch {
                // Failed to parse
              }
            }
          }
        }

        credentials.push({
          name: 'Claude Code OAuth',
          source: claudeFound ? claudeSource : 'not found',
          found: claudeFound,
          preview: claudePreview || undefined,
          expiresAt: claudeExpires,
          tokenType: claudeTokenType,
        });
      }

      // Check Codex credentials
      if (checkCodex) {
        let codexFound = false;
        let codexSource = '';
        let codexPreview = '';
        let codexUsable: boolean | undefined;
        let codexLastRefresh: string | undefined;
        let codexAccessTokenValid: boolean | undefined;
        let codexRefreshTokenPresent: boolean | undefined;
        let codexRefreshTokenUsable: boolean | undefined;
        let codexValidationStatus: string | undefined;
        let codexError: string | undefined;
        let codexAction: string | undefined;
        let codexExpires: string | undefined;

        // Prefer auth files because they include the refresh token the worker needs.
        const codexValidation = await resolveCodexAuthForSync({
          validateRefresh: true,
          persistRefresh: true,
        });
        if (codexValidation.found) {
          codexFound = true;
          codexUsable = codexValidation.usable;
          codexSource = codexValidation.candidate?.sourcePath.replace(homedir(), '~') ?? 'auth.json';
          codexLastRefresh = codexValidation.lastRefresh;
          codexAccessTokenValid = codexValidation.accessTokenValid;
          codexRefreshTokenPresent = codexValidation.refreshTokenPresent;
          codexRefreshTokenUsable = codexValidation.refreshTokenUsable;
          codexValidationStatus = codexValidation.validationStatus;
          codexError = codexValidation.error;
          codexAction = codexValidation.usable ? undefined : 'Run `codex login --device-auth` and then retry `eve auth sync --codex`.';
          if (codexValidation.accessToken) {
            codexPreview = codexValidation.accessToken.substring(0, 15) + '...';
          } else if (codexValidation.apiKey) {
            codexSource += ' (API key)';
            codexPreview = codexValidation.apiKey.substring(0, 10) + '...';
          }
          if (codexValidation.expiresAt && codexValidation.expiresAt > 0) {
            codexExpires = new Date(codexValidation.expiresAt * 1000).toISOString();
          }
        }

        // Try macOS Keychain only when no auth.json exists.
        if (plat === 'darwin' && !codexFound) {
          for (const service of ['openai.codex', 'Code-credentials']) {
            try {
              const output = execSync(
                `security find-generic-password -s "${service}" -w`,
                { encoding: 'utf8' }
              ).trim();
              if (output) {
                codexFound = true;
                codexUsable = true;
                codexSource = `macOS Keychain (${service})`;
                codexPreview = output.substring(0, 15) + '...';
                break;
              }
            } catch {
              // Not found
            }
          }
        }

        credentials.push({
          name: 'Codex/Code OAuth',
          source: codexFound ? codexSource : 'not found',
          found: codexFound,
          usable: codexUsable,
          preview: codexPreview || undefined,
          expiresAt: codexExpires,
          lastRefresh: codexLastRefresh,
          accessTokenValid: codexAccessTokenValid,
          refreshTokenPresent: codexRefreshTokenPresent,
          refreshTokenUsable: codexRefreshTokenUsable,
          validationStatus: codexValidationStatus,
          error: codexError,
          action: codexAction,
        });
      }

      const foundCount = credentials.filter(c => c.found).length;

      if (json) {
        outputJson({ credentials, found: foundCount }, json);
        return;
      }

      console.log('Local AI Tool Credentials:');
      console.log('');
      for (const cred of credentials) {
        const status = cred.found && cred.usable !== false ? '✓' : '✗';
        console.log(`  ${status} ${cred.name}`);
        console.log(`    Source: ${cred.source}`);
        if (cred.tokenType) {
          const typeLabel = cred.tokenType === 'setup-token' ? 'setup-token (long-lived)' : 'oauth (short-lived, ~15h)';
          console.log(`    Type:   ${typeLabel}`);
        } else if (cred.validationStatus === 'api_key') {
          console.log('    Type:   API key');
        }
        if (cred.preview) {
          console.log(`    Token:  ${cred.preview}`);
        }
        if (cred.accessTokenValid !== undefined) {
          console.log(`    Access: ${cred.accessTokenValid ? 'valid' : 'expired or unusable'}`);
        }
        if (cred.refreshTokenPresent !== undefined) {
          const refreshLabel = cred.refreshTokenUsable === true
            ? 'usable'
            : cred.refreshTokenPresent
              ? 'not usable'
              : 'missing';
          console.log(`    Refresh: ${refreshLabel}`);
        }
        if (cred.lastRefresh) {
          console.log(`    Last refresh: ${cred.lastRefresh}`);
        }
        if (cred.expiresAt) {
          const expDate = new Date(cred.expiresAt);
          const now = new Date();
          const isExpired = expDate < now;
          const expLabel = isExpired ? ' (expired)' : '';
          console.log(`    Expires: ${cred.expiresAt}${expLabel}`);
        }
        if (cred.error) {
          console.log(`    Error: ${cred.error}`);
        }
        if (cred.action) {
          console.log(`    Action: ${cred.action}`);
        }
        console.log('');
      }

      const invalidCount = credentials.filter(c => c.found && c.usable === false).length;
      if (invalidCount > 0) {
        console.log(`${invalidCount} credential(s) need attention before syncing to Eve.`);
      } else if (foundCount > 0) {
        console.log(`Found ${foundCount} credential(s). Run 'eve auth sync' to sync to Eve.`);
      } else {
        console.log('No local credentials found.');
        console.log('');
        console.log('To set up credentials:');
        console.log('  Claude: Run "claude" CLI and log in');
        console.log('  Codex:  Run "codex" CLI and log in');
      }
      return;
    }
    case 'verify': {
      await handleAuthVerify(flags, context, json);
      return;
    }
    case 'request-access': {
      const statusId = getStringFlag(flags, ['status']);

      // Poll mode: check status of existing request
      if (statusId) {
        type AccessRequestStatus = {
          id: string;
          status: string;
          org_id: string | null;
          desired_org_name: string;
        };
        const response = await requestRaw(context, `/auth/request-access/${statusId}`, {
          allowError: true,
          tokenOverride: '',
        });
        if (!response.ok) {
          throw new Error(`Failed to check request status: ${response.text}`);
        }
        const data = response.data as AccessRequestStatus;
        outputJson(data, json, `Request ${data.id}: ${data.status}`);
        return;
      }

      // Submit mode
      const orgName = getStringFlag(flags, ['org']);
      const orgSlug = getStringFlag(flags, ['org-slug']);
      const requestEmail = getStringFlag(flags, ['email']);
      const wait = getBooleanFlag(flags, ['wait']) ?? false;

      if (!orgName) {
        throw new Error('Usage: eve auth request-access --org "My Company" [--ssh-key ~/.ssh/id_ed25519.pub] [--nostr-pubkey <hex>] [--email <email>] [--wait]');
      }

      // Determine provider and public key
      const nostrPubkey = getStringFlag(flags, ['nostr-pubkey']);
      let provider: string;
      let publicKey: string;

      if (nostrPubkey) {
        provider = 'nostr';
        publicKey = nostrPubkey;
      } else {
        provider = 'github_ssh';
        const sshKeyPath =
          getStringFlag(flags, ['ssh-key']) ||
          process.env.EVE_AUTH_SSH_KEY ||
          context.profile.default_ssh_key ||
          join(homedir(), '.ssh', 'id_ed25519.pub');

        if (!existsSync(sshKeyPath)) {
          throw new Error(`SSH public key not found at ${sshKeyPath}. Use --ssh-key <path> to specify.`);
        }
        publicKey = readFileSync(sshKeyPath, 'utf8').trim();
      }

      // Submit request (unauthenticated)
      const submitResponse = await requestRaw(context, '/auth/request-access', {
        method: 'POST',
        tokenOverride: '',
        body: {
          provider,
          public_key: publicKey,
          email: requestEmail,
          desired_org_name: orgName,
          desired_org_slug: orgSlug,
        },
      });

      if (!submitResponse.ok) {
        throw new Error(`Failed to submit access request: ${submitResponse.text}`);
      }

      type AccessRequestData = {
        id: string;
        status: string;
        org_id: string | null;
        org_slug?: string | null;
        desired_org_slug: string | null;
      };
      const requestData = submitResponse.data as AccessRequestData;

      if (!wait) {
        outputJson(requestData, json, `Access request submitted: ${requestData.id} (status: ${requestData.status})\nPoll with: eve auth request-access --status ${requestData.id}\n\nTip: Use --wait to auto-poll and login on approval:\n  eve auth request-access --org "${orgName}" --wait`);
        return;
      }

      // Wait mode: poll until approved or rejected
      console.log(`Access request submitted: ${requestData.id}`);
      console.log('Waiting for admin approval...');

      const POLL_INTERVAL_MS = 5000;
      let current = requestData;
      while (current.status === 'pending') {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        const pollResponse = await requestRaw(context, `/auth/request-access/${current.id}`, {
          allowError: true,
          tokenOverride: '',
        });
        if (pollResponse.ok) {
          current = pollResponse.data as AccessRequestData;
          process.stdout.write('.');
        }
      }
      console.log('');

      if (current.status === 'rejected') {
        throw new Error('Access request was rejected.');
      }

      if (current.status === 'approved') {
        console.log('Approved! Logging in...');

        // Use the same SSH key to log in via challenge/verify
        const loginResult = await attemptSshLogin(context, credentials, flags, requestEmail, undefined);
        if (loginResult.success) {
          outputJson(
            { ...current, logged_in: true },
            json,
            `Approved and logged in! Org: ${current.desired_org_slug ?? current.org_id}`,
          );
        } else {
          outputJson(
            { ...current, logged_in: false, login_error: loginResult.error },
            json,
            `Approved but login failed: ${loginResult.error}\nTry: eve auth login --email ${requestEmail ?? '<email>'}`,
          );
        }
      }
      return;
    }
    case 'create-service-account': {
      const name = getStringFlag(flags, ['name']);
      const orgId = getStringFlag(flags, ['org']);
      const scopesStr = getStringFlag(flags, ['scopes']);
      const description = getStringFlag(flags, ['description']);
      const ttlStr = getStringFlag(flags, ['ttl']);
      const ttlHours = ttlStr ? parseInt(ttlStr, 10) : 1;

      if (!name || !orgId) {
        throw new Error('Usage: eve auth create-service-account --name <name> --org <org_id> --scopes "scope1,scope2" [--description <desc>] [--ttl <hours>]');
      }

      if (ttlStr && (isNaN(ttlHours) || ttlHours < 1 || ttlHours > 8760)) {
        throw new Error('--ttl must be between 1 and 8760 hours');
      }

      // Step 1: Create the service principal
      type SpResponse = { id: string; org_id: string; name: string; description: string | null; created_at: string };
      const sp = await requestJson<SpResponse>(context, `/orgs/${orgId}/service-principals`, {
        method: 'POST',
        body: {
          name,
          description: description ?? undefined,
        },
      });

      if (!sp?.id) {
        throw new Error('Failed to create service principal');
      }

      // Step 2: Mint a token if scopes are provided
      if (scopesStr) {
        const scopes = scopesStr.split(',').map((s) => s.trim()).filter(Boolean);
        if (scopes.length === 0) {
          throw new Error('--scopes must contain at least one scope');
        }

        type TokenResponse = { token_id: string; access_token: string; scopes: string[]; expires_at: string };
        const token = await requestJson<TokenResponse>(context, `/orgs/${orgId}/service-principals/${sp.id}/tokens`, {
          method: 'POST',
          body: {
            scopes,
            ttl_hours: ttlHours,
          },
        });

        if (json) {
          outputJson({ ...sp, token }, json);
          return;
        }

        console.log(`Service account created: ${sp.name} (${sp.id})`);
        console.log(`Token ID: ${token.token_id}`);
        console.log(`Expires: ${token.expires_at}`);
        console.log(`Scopes: ${token.scopes.join(', ')}`);
        console.log('');
        console.log('Access token (shown once):');
        console.log(token.access_token);
        return;
      }

      outputJson(sp, json, `Service account created: ${sp.name} (${sp.id})\nNo token minted (use --scopes to mint a token).`);
      return;
    }
    case 'list-service-accounts': {
      const orgId = getStringFlag(flags, ['org']);

      if (!orgId) {
        throw new Error('Usage: eve auth list-service-accounts --org <org_id>');
      }

      type SpResponse = { id: string; org_id: string; name: string; description: string | null; created_at: string };
      const principalsResponse = await requestJson<{ data: SpResponse[] } | SpResponse[]>(
        context,
        `/orgs/${orgId}/service-principals`,
      );
      const principals = unwrapListResponse(principalsResponse);

      if (json) {
        outputJson({ data: principals }, json);
        return;
      }

      if (!principals || principals.length === 0) {
        console.log('No service accounts found.');
        return;
      }

      console.log('Service Accounts:');
      console.log('');
      const header = 'ID'.padEnd(30) + 'Name'.padEnd(25) + 'Created';
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const sp of principals) {
        console.log(`${sp.id.padEnd(30)}${sp.name.padEnd(25)}${sp.created_at}`);
      }
      return;
    }
    case 'revoke-service-account': {
      const orgId = getStringFlag(flags, ['org']);
      const name = getStringFlag(flags, ['name']);
      const spId = getStringFlag(flags, ['id']);

      if (!orgId || (!name && !spId)) {
        throw new Error('Usage: eve auth revoke-service-account --org <org_id> --name <name> (or --id <sp_id>)');
      }

      // Resolve by name if needed
      let resolvedId = spId;
      if (!resolvedId && name) {
        type SpResponse = { id: string; name: string };
        const principalsResponse = await requestJson<{ data: SpResponse[] } | SpResponse[]>(
          context,
          `/orgs/${orgId}/service-principals`,
        );
        const principals = unwrapListResponse(principalsResponse);
        const match = principals?.find((sp) => sp.name === name);
        if (!match) {
          throw new Error(`Service account not found: ${name}`);
        }
        resolvedId = match.id;
      }

      await requestRaw(context, `/orgs/${orgId}/service-principals/${resolvedId}`, {
        method: 'DELETE',
      });

      outputJson({ id: resolvedId, deleted: true }, json, `Service account deleted: ${resolvedId}`);
      return;
    }
    default:
      throw new Error('Usage: eve auth <login|logout|status|whoami|bootstrap|sync|creds|verify|token|mint|permissions|request-access|create-service-account|list-service-accounts|revoke-service-account>');
  }
}

function formatCodexAuthValidationError(validation: CodexAuthValidation): string {
  const source = validation.candidate?.sourcePath.replace(homedir(), '~') ?? 'Codex credential file';
  const details = validation.error ? `\nDetails: ${validation.error}` : '';
  const lastRefresh = validation.lastRefresh ? `\nLast refresh: ${validation.lastRefresh}` : '';
  const expires = validation.expiresAt ? `\nAccess token expires: ${new Date(validation.expiresAt * 1000).toISOString()}` : '';
  const action = validation.reloginRequired !== false
    ? '\nRun `codex login --device-auth` and then retry `eve auth sync --codex`.'
    : '\nRetry after network/API connectivity is healthy.';

  return `Codex credential file exists, but refresh token is not usable.\nSource: ${source}${lastRefresh}${expires}${details}${action}`;
}

type AuthVerifyJob = {
  id: string;
  phase: string;
};

type AuthVerifyAttempt = {
  attempt_number: number;
  status: string;
};

type AuthVerifyResultResponse = {
  jobId: string;
  status: string;
  exitCode: number | null;
  resultText: string | null;
  resultJson: Record<string, unknown> | null;
  errorMessage: string | null;
};

type AuthVerifyLog = {
  type: string;
  line: Record<string, unknown>;
};

type AuthVerifyOutput = {
  ok: boolean;
  job_id: string;
  attempt_number: number | null;
  harness: string;
  auth_source: string | null;
  secret_key: string | null;
  scope_type: string | null;
  scope_id: string | null;
  token_class: string | null;
  apiKeySource: string | null;
  model_replied: boolean;
  reason?: string;
  error?: string | null;
};

async function handleAuthVerify(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const harness = getStringFlag(flags, ['harness']) ?? 'claude';
  if (harness !== 'claude' && harness !== 'mclaude') {
    throw new Error('--harness must be claude or mclaude');
  }

  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Usage: eve auth verify --harness claude --project <id> [--json]');
  }

  const timeoutSeconds = parsePositiveInt(getStringFlag(flags, ['timeout']) ?? '300', '--timeout');
  const job = await requestJson<AuthVerifyJob>(context, `/projects/${projectId}/jobs`, {
    method: 'POST',
    body: {
      title: `Claude auth verify (${harness})`,
      description: 'Reply with exactly: EVE_AUTH_OK',
      issue_type: 'task',
      labels: ['auth-verify', 'claude-auth-verify'],
      priority: 1,
      review_required: 'none',
      execution_mode: 'ephemeral',
      harness,
      hints: {
        auth_probe: true,
        skip_workspace_skills: true,
        permission_policy: 'never',
        timeout_seconds: Math.min(timeoutSeconds, 300),
      },
    },
  });

  if (!json) {
    console.log(`Created auth probe job: ${job.id}`);
  }

  const waitResult = await waitForAuthVerifyJob(context, job.id, timeoutSeconds);
  const attempts = await requestJson<{ attempts: AuthVerifyAttempt[] }>(context, `/jobs/${job.id}/attempts`);
  const latestAttempt = attempts.attempts.length > 0
    ? attempts.attempts.reduce((latest, attempt) =>
        attempt.attempt_number > latest.attempt_number ? attempt : latest,
      )
    : null;
  const logs = latestAttempt
    ? await requestJson<{ logs: AuthVerifyLog[] }>(
        context,
        `/jobs/${job.id}/attempts/${latestAttempt.attempt_number}/logs`,
      )
    : { logs: [] };

  const facts = extractAuthVerifyFacts(logs.logs);
  const modelReplied = Boolean(waitResult.resultText?.includes('EVE_AUTH_OK'))
    || JSON.stringify(waitResult.resultJson ?? {}).includes('EVE_AUTH_OK');
  const succeeded = waitResult.status === 'succeeded' && (waitResult.exitCode ?? 0) === 0;
  const apiKeySourceOk = Boolean(facts.apiKeySource && facts.apiKeySource !== 'none');
  const ok = succeeded && apiKeySourceOk && modelReplied;
  const reason = ok
    ? undefined
    : readString(facts.failure?.probable_cause)
      ?? readString(facts.failure?.reason)
      ?? (!succeeded ? waitResult.errorMessage ?? `Job ${waitResult.status}` : undefined)
      ?? (!apiKeySourceOk ? 'Claude system/init did not report a usable apiKeySource' : undefined)
      ?? (!modelReplied ? 'Claude did not return EVE_AUTH_OK' : undefined)
      ?? 'Claude auth verification failed';

  const selected = facts.selected;
  const output: AuthVerifyOutput = {
    ok,
    job_id: job.id,
    attempt_number: latestAttempt?.attempt_number ?? null,
    harness,
    auth_source: readString(selected?.source),
    secret_key: readString(selected?.secret_key),
    scope_type: readString(selected?.scope_type),
    scope_id: readString(selected?.scope_id),
    token_class: readString(selected?.token_class),
    apiKeySource: facts.apiKeySource,
    model_replied: modelReplied,
    reason,
    error: waitResult.errorMessage,
  };

  if (json) {
    outputJson(output, true);
  } else if (ok) {
    console.log(`Claude auth verified (${output.scope_type ?? 'unknown'} ${output.secret_key ?? 'unknown'}, ${output.token_class ?? 'unknown'}).`);
    console.log(`apiKeySource=${output.apiKeySource}`);
  } else {
    console.log(`Claude auth verification failed: ${reason}`);
    console.log(`Job: ${job.id}`);
    if (output.secret_key || output.scope_type) {
      console.log(`Selected: ${output.scope_type ?? 'unknown'} ${output.secret_key ?? 'unknown'} (${output.token_class ?? 'unknown'})`);
    }
    if (output.apiKeySource) {
      console.log(`apiKeySource=${output.apiKeySource}`);
    }
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

async function waitForAuthVerifyJob(
  context: ResolvedContext,
  jobId: string,
  timeoutSeconds: number,
): Promise<AuthVerifyResultResponse> {
  const start = Date.now();
  let pollTimeout = 5;

  while (Date.now() - start < timeoutSeconds * 1000) {
    const elapsedSeconds = Math.floor((Date.now() - start) / 1000);
    const remaining = Math.max(1, timeoutSeconds - elapsedSeconds);
    const current = Math.min(pollTimeout, remaining, 60);
    const response = await requestRaw(context, `/jobs/${jobId}/wait?timeout=${current}`);
    if (response.status === 200) {
      return response.data as AuthVerifyResultResponse;
    }
    if (response.status !== 202) {
      throw new Error(`Auth verify wait failed: HTTP ${response.status}: ${response.text}`);
    }
    pollTimeout = Math.min(pollTimeout * 2, 30);
  }

  return {
    jobId,
    status: 'timeout',
    exitCode: null,
    resultText: null,
    resultJson: null,
    errorMessage: `Timed out after ${timeoutSeconds}s`,
  };
}

function extractAuthVerifyFacts(logs: AuthVerifyLog[]): {
  selected: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  apiKeySource: string | null;
} {
  let selected: Record<string, unknown> | null = null;
  let failure: Record<string, unknown> | null = null;
  let apiKeySource: string | null = null;

  for (const log of logs) {
    const line = log.line;
    if (!line || typeof line !== 'object') continue;

    if (log.type === 'claude_auth_selected' || line.event === 'claude_auth_selected') {
      selected = line;
    }
    if (log.type === 'claude_auth_failed' || line.event === 'claude_auth_failed') {
      failure = line;
    }
    const source = readClaudeApiKeySource(line);
    if (source) {
      apiKeySource = source;
    }
  }

  if (!apiKeySource && failure) {
    apiKeySource = readString(failure.apiKeySource);
  }

  return { selected, failure, apiKeySource };
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const SSH_KEY_IGNORE = new Set([
  'config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment',
]);

const SSH_KEY_PRIORITY: Record<string, number> = {
  id_ed25519: 0,
  id_ecdsa: 1,
  id_rsa: 2,
};

/**
 * Scan ~/.ssh/ for private keys with matching .pub files.
 * Returns candidates sorted by preference: ed25519 > ecdsa > rsa > others.
 */
function discoverSshKeys(): string[] {
  const sshDir = join(homedir(), '.ssh');
  if (!existsSync(sshDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(sshDir);
  } catch {
    return [];
  }

  const candidates: { path: string; priority: number }[] = [];

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name.endsWith('.pub')) continue;
    if (SSH_KEY_IGNORE.has(name)) continue;

    // Must start with id_ or contain "key" to be a likely private key
    if (!name.startsWith('id_') && !name.includes('key')) continue;

    const fullPath = join(sshDir, name);
    const pubPath = `${fullPath}.pub`;

    // Require matching .pub file — strong signal it's a keypair
    if (!existsSync(pubPath)) continue;

    const priority = SSH_KEY_PRIORITY[name] ?? 10;
    candidates.push({ path: fullPath, priority });
  }

  return candidates
    .sort((a, b) => a.priority - b.priority)
    .map((c) => c.path);
}

function signNonceWithSsh(keyPath: string, nonce: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'eve-auth-'));
  const noncePath = join(tempDir, 'nonce');
  const signaturePath = `${noncePath}.sig`;

  try {
    writeFileSync(noncePath, nonce);
    const result = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', keyPath, '-n', 'eve-auth', noncePath], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`ssh-keygen failed: ${result.stderr || 'unknown error'}`);
    }

    return readFileSync(signaturePath, 'utf8');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

type SshLoginResult = {
  success: boolean;
  tokenType?: string;
  error?: string;
};

async function attemptSshLogin(
  context: ResolvedContext,
  credentials: CredentialsFile,
  flags: Record<string, FlagValue>,
  email: string | undefined,
  userId: string | undefined,
  ttlDays?: number,
): Promise<SshLoginResult> {
  // Determine which SSH keys to try
  const explicitKey =
    getStringFlag(flags, ['ssh-key']) ||
    process.env.EVE_AUTH_SSH_KEY ||
    context.profile.default_ssh_key;

  const keysToTry = explicitKey ? [explicitKey] : discoverSshKeys();

  if (keysToTry.length === 0) {
    return {
      success: false,
      error: 'No SSH keys found. Provide --ssh-key <path> or add a keypair to ~/.ssh/',
    };
  }

  // Request a single challenge (reusable across key attempts)
  const challengeResponse = await requestRaw(context, '/auth/challenge', {
    method: 'POST',
    body: { email, user_id: userId },
  });

  if (!challengeResponse.ok) {
    const message = typeof challengeResponse.data === 'string'
      ? challengeResponse.data
      : challengeResponse.text;
    return { success: false, error: `Challenge failed: ${message}` };
  }

  const challenge = challengeResponse.data as { challenge_id?: string; nonce?: string };
  if (!challenge.challenge_id || !challenge.nonce) {
    return { success: false, error: 'Challenge response missing fields' };
  }

  let lastError = '';

  for (const keyPath of keysToTry) {
    let signature: string;
    try {
      signature = signNonceWithSsh(keyPath, challenge.nonce);
    } catch {
      // Key can't sign (wrong format, passphrase-protected without agent, etc.) — skip
      continue;
    }

    const verifyResponse = await requestRaw(context, '/auth/verify', {
      method: 'POST',
      body: {
        challenge_id: challenge.challenge_id,
        signature,
        ...(ttlDays !== undefined && { ttl_days: ttlDays }),
      },
    });

    if (verifyResponse.ok) {
      const payload = verifyResponse.data as {
        access_token?: string;
        token_type?: string;
        expires_at?: number;
      };

      if (!payload.access_token) {
        return { success: false, error: 'Auth verify response missing access_token' };
      }

      credentials.tokens[context.authKey] = {
        access_token: payload.access_token,
        expires_at: payload.expires_at,
        token_type: payload.token_type,
      };
      saveCredentials(credentials);

      // Tell the user which key worked (especially useful during auto-discovery)
      if (!explicitKey) {
        const shortPath = keyPath.replace(homedir(), '~');
        console.log(`Using SSH key: ${shortPath}`);
      }

      return { success: true, tokenType: payload.token_type };
    }

    // Capture error for reporting if all keys fail
    lastError = typeof verifyResponse.data === 'string'
      ? verifyResponse.data
      : verifyResponse.text;
  }

  return { success: false, error: `Auth verify failed: ${lastError}` };
}

async function fetchGitHubKeys(username: string): Promise<string[]> {
  const response = await fetch(`https://github.com/${username}.keys`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`GitHub user not found: ${username}`);
    }
    throw new Error(`Failed to fetch GitHub keys: HTTP ${response.status}`);
  }

  const text = await response.text();
  return text.trim().split('\n').filter(k => k.length > 0);
}

async function offerGitHubKeyRegistration(
  context: ResolvedContext,
  email: string | undefined,
): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\nNo registered SSH key found for this user.');
    const username = await rl.question('Enter GitHub username to register keys (or press Enter to skip): ');

    if (!username.trim()) {
      return false;
    }

    let keys: string[];
    try {
      keys = await fetchGitHubKeys(username.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to fetch GitHub keys: ${msg}`);
      return false;
    }

    if (keys.length === 0) {
      console.log(`No SSH keys found for github.com/${username}`);
      return false;
    }

    console.log(`\nFound ${keys.length} SSH key(s) for github.com/${username.trim()}`);
    const confirm = await rl.question('Register them? [Y/n]: ');

    if (confirm.toLowerCase() === 'n' || confirm.toLowerCase() === 'no') {
      return false;
    }

    // Register each key
    let registered = 0;
    for (const publicKey of keys) {
      try {
        await requestJson(context, '/auth/identities', {
          method: 'POST',
          body: {
            email,
            public_key: publicKey,
            label: `github-${username.trim()}`,
          },
        });
        registered += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to register key: ${msg}`);
      }
    }

    if (registered === 0) {
      console.log('No keys were registered');
      return false;
    }

    console.log(`✓ Registered ${registered} SSH key(s)`);
    return true;
  } finally {
    rl.close();
  }
}

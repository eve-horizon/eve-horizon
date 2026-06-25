import express from 'express';
import cookieParser from 'cookie-parser';
import { createHmac, timingSafeEqual } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const EVE_API_URL = process.env.EVE_API_URL ?? 'http://eve-api.eve.svc.cluster.local:4701';
const SUPABASE_AUTH_URL = process.env.SUPABASE_AUTH_URL ?? 'http://supabase-auth.eve.svc.cluster.local:9999';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const EVE_DEFAULT_DOMAIN = process.env.EVE_DEFAULT_DOMAIN ?? 'lvh.me';
const SECURE_COOKIES = process.env.EVE_SSO_SECURE_COOKIES === 'true';
// SameSite for the SSO session cookies.
//   - SECURE_COOKIES=true (staging/prod, https://): use 'none' so cross-site
//     fetch from custom-domain apps (e.g. sandbox.acme.example) to the
//     SSO origin (sso.eve.example.com) carries the cookies. The previous
//     'lax' value caused 401 No session on the React SDK's /session probe.
//     SameSite=None requires Secure (browser-enforced) — only emitted on
//     https://. See apps/sso README and docs/system/auth.md.
//   - SECURE_COOKIES=false (local k3d, http:// lvh.me): use 'lax'. Browsers
//     reject SameSite=None on insecure origins; lvh.me apps are same-site
//     anyway so cross-site fetch is not an issue locally.
const COOKIE_SAMESITE: 'none' | 'lax' = SECURE_COOKIES ? 'none' : 'lax';
const SIGNUP_ALLOWED_DOMAINS: string[] = (process.env.EVE_SIGNUP_ALLOWED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);
const EVE_INTERNAL_API_KEY = process.env.EVE_INTERNAL_API_KEY ?? '';
// Wrap tokens have the typeid('mlw') shape: lowercase prefix + 26-char base32.
// Validating against this regex before hitting the API gives scanners crafting
// malformed paths a quick 404 and avoids logging arbitrary user input.
const WRAP_TOKEN_REGEX = /^mlw_[0-9a-z]{26}$/;

type LoginMethod = 'password_or_magic_link' | 'password' | 'magic_link';

type ProjectBranding = {
  app_name: string;
  app_logo_url?: string;
  primary_color?: string;
  email_from_name?: string;
  reply_to_email?: string;
  support_email?: string;
  support_url?: string;
};

type ProjectAuthConfig = {
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

type SsoLoginContext = {
  project_id: string;
  org_id: string;
  branding: ProjectBranding | null;
  auth: ProjectAuthConfig | null;
};

const LOCAL_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function isLocalHttpOrigin(parsed: URL): boolean {
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HTTP_HOSTNAMES.has(host)) return true;
  if (host === 'lvh.me' || host.endsWith('.lvh.me')) return true;
  return false;
}

function isClusterDomainHost(host: string): boolean {
  return host === EVE_DEFAULT_DOMAIN || host.endsWith(`.${EVE_DEFAULT_DOMAIN}`);
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function isHttpsUrl(value: string | undefined): value is string {
  return typeof value === 'string' && value.toLowerCase().startsWith('https://');
}

/**
 * Validate a post-auth `redirect_to` URL. Accepts:
 *   - Any URL whose hostname is the cluster domain or a subdomain of it.
 *   - Any URL whose origin matches a project-declared allowed origin.
 * Project-declared origins must be HTTPS (or local-only HTTP for dev).
 */
function isAllowedRedirect(
  url: string,
  context: { allowedOrigins?: string[] } = {},
): boolean {
  try {
    const parsed = new URL(url);
    if (isClusterDomainHost(parsed.hostname)) {
      return true;
    }
    if (parsed.protocol !== 'https:' && !isLocalHttpOrigin(parsed)) {
      return false;
    }
    const allowed = (context.allowedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin));
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** Validate a CORS request `Origin` against cluster + project-declared origins. */
function isAllowedOrigin(
  origin: string,
  context: { allowedOrigins?: string[] } = {},
): boolean {
  try {
    const parsed = new URL(origin);
    if (isClusterDomainHost(parsed.hostname)) {
      return true;
    }
    if (parsed.protocol !== 'https:' && !isLocalHttpOrigin(parsed)) {
      return false;
    }
    const allowed = (context.allowedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((o): o is string => Boolean(o));
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** Check whether an email is allowed for self-signup. Returns true when unrestricted. */
function isSignupEmailAllowed(email: string): boolean {
  if (SIGNUP_ALLOWED_DOMAINS.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && SIGNUP_ALLOWED_DOMAINS.includes(domain);
}

// ---------------------------------------------------------------------------
// Magic-link wrap interstitial helpers
// ---------------------------------------------------------------------------

type WrapInspectResponse =
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

type WrapConsumeResponse =
  | {
      status: 'ok';
      gotrue_action_link: string;
      kind: 'magic_link' | 'invite';
      project_id: string | null;
      org_id: string | null;
    }
  | { status: 'expired' | 'already_consumed' | 'unknown' };

async function internalApiPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  if (!EVE_INTERNAL_API_KEY) {
    console.error('[wrap] EVE_INTERNAL_API_KEY not configured — refusing to call internal API');
    return null;
  }
  try {
    const res = await fetch(`${EVE_API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': EVE_INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[wrap] ${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[wrap] ${path} fetch error:`, err);
    return null;
  }
}

function signWrapCsrf(wrapToken: string): string {
  // Stateless CSRF: HMAC-SHA256 of the wrap_token using the internal API key.
  // Stored in a hidden form field. Defends against accidental cross-origin
  // form submissions; the wrap_token itself remains the bearer credential.
  return createHmac('sha256', EVE_INTERNAL_API_KEY || 'unconfigured').update(wrapToken).digest('hex');
}

function verifyWrapCsrf(wrapToken: string, nonce: string): boolean {
  if (!nonce || nonce.length !== 64) return false;
  const expected = signWrapCsrf(wrapToken);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(nonce, 'hex'));
  } catch {
    return false;
  }
}

function isValidWrapToken(token: string): boolean {
  return WRAP_TOKEN_REGEX.test(token);
}

async function fetchAppContext(projectId: string | undefined): Promise<SsoLoginContext | null> {
  if (!projectId) return null;
  try {
    const res = await fetch(`${EVE_API_URL}/auth/app-context?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) {
      console.error('[app-context] API returned', res.status, await res.text());
      return null;
    }
    return await res.json() as SsoLoginContext;
  } catch (err) {
    console.error('[app-context] Fetch error:', err);
    return null;
  }
}

function buildQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function appendQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Set root-domain session cookies after successful auth. */
function setSessionCookies(
  res: express.Response,
  refreshToken: string,
): void {
  const cookieDomain = `.${EVE_DEFAULT_DOMAIN}`;

  // httpOnly refresh token cookie -- never accessible to JavaScript
  res.cookie('eve_sso_rt', refreshToken, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: COOKIE_SAMESITE,
    path: '/',
    domain: cookieDomain,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });

  // UX hint cookie -- non-httpOnly so apps can detect presence
  res.cookie('eve_sso', '1', {
    httpOnly: false,
    secure: SECURE_COOKIES,
    sameSite: COOKIE_SAMESITE,
    path: '/',
    domain: cookieDomain,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/** Clear session cookies. */
function clearSessionCookies(res: express.Response): void {
  const cookieDomain = `.${EVE_DEFAULT_DOMAIN}`;
  res.clearCookie('eve_sso_rt', { path: '/', domain: cookieDomain });
  res.clearCookie('eve_sso', { path: '/', domain: cookieDomain });
}

/** Refresh a Supabase session using a refresh token. Returns { access_token, refresh_token }. */
async function refreshSupabaseSession(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const url = `${SUPABASE_AUTH_URL}/token?grant_type=refresh_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GoTrue refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

/** Exchange a Supabase access token for an Eve RS256 token via the Eve API. */
async function exchangeForEveToken(
  supabaseAccessToken: string,
): Promise<{
  access_token: string;
  expires_at: string;
  user_id: string;
  invite_redirect_to?: string;
  invite_org_id?: string;
  invite_app_context?: { project_id?: string; org_id?: string } & Record<string, unknown>;
}> {
  const url = `${EVE_API_URL}/auth/exchange`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseAccessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Eve exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{
    access_token: string;
    expires_at: string;
    user_id: string;
    invite_redirect_to?: string;
    invite_org_id?: string;
    invite_app_context?: { project_id?: string; org_id?: string } & Record<string, unknown>;
  }>;
}

/** Decode a JWT payload without verification (for extracting email/user info from Supabase token). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Login page HTML
// ---------------------------------------------------------------------------

function loginPageHtml(
  redirectTo: string,
  mode: string,
  error?: string,
  context?: SsoLoginContext | null,
): string {
  const escapedError = error ? escapeHtml(error) : '';
  const auth = context?.auth ?? {
    login_method: 'password_or_magic_link' as const,
    self_signup: true,
    invite_requires_password: true,
  };
  const branding = context?.branding ?? null;
  const appName = branding?.app_name?.trim() || 'Eve';
  const escapedAppName = escapeHtml(appName);
  const logoHtml = isHttpsUrl(branding?.app_logo_url)
    ? `<img src="${escapeHtml(branding.app_logo_url)}" alt="${escapedAppName}" style="display:block;max-width:180px;max-height:64px;margin:0 auto 0.75rem;">`
    : '';
  const primaryColor = branding?.primary_color ?? '#ffffff';
  const primaryTextColor = primaryColor.toLowerCase() === '#ffffff' ? '#0a0a0a' : '#ffffff';
  const showPassword = auth.login_method !== 'magic_link';
  const showMagicLink = auth.login_method !== 'password';
  const magicOnly = showMagicLink && !showPassword;
  const appScopedMagicLink = Boolean(context?.auth && showMagicLink);
  const allowSignup = showPassword && auth.self_signup;
  const isSignup = allowSignup && mode === 'signup';
  const submitText = magicOnly ? 'Send sign-in link' : isSignup ? 'Create Account' : 'Sign In';
  const domainHint = SIGNUP_ALLOWED_DOMAINS.length > 0
    ? SIGNUP_ALLOWED_DOMAINS.join(', ')
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedAppName} - Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .container {
      width: 100%;
      max-width: 400px;
    }
    .logo {
      text-align: center;
      margin-bottom: 2rem;
    }
    .logo h1 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: #fff;
    }
    .logo p {
      color: #737373;
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }
    .card {
      background: #141414;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 2rem;
    }
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid #262626;
    }
    .tab {
      flex: 1;
      background: none;
      border: none;
      color: #737373;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.75rem 0;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab:hover { color: #a3a3a3; }
    .tab.active {
      color: #fff;
      border-bottom-color: #fff;
    }
    .field {
      margin-bottom: 1rem;
    }
    .field label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: #a3a3a3;
      margin-bottom: 0.375rem;
    }
    .field input {
      width: 100%;
      padding: 0.625rem 0.75rem;
      background: #0a0a0a;
      border: 1px solid #262626;
      border-radius: 8px;
      color: #fff;
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .field input:focus {
      border-color: #525252;
    }
    .field input::placeholder { color: #525252; }
    .btn {
      width: 100%;
      padding: 0.625rem;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary {
      background: ${primaryColor};
      color: ${primaryTextColor};
      margin-bottom: 0.75rem;
    }
    .btn-primary:hover:not(:disabled) { opacity: 0.88; }
    .btn-secondary {
      background: transparent;
      color: #a3a3a3;
      border: 1px solid #262626;
    }
    .btn-secondary:hover:not(:disabled) {
      background: #1a1a1a;
      color: #fff;
    }
    .divider {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin: 1.25rem 0;
      color: #525252;
      font-size: 0.75rem;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #262626;
    }
    .error {
      background: #1a0000;
      border: 1px solid #3b0000;
      color: #ef4444;
      padding: 0.625rem 0.75rem;
      border-radius: 8px;
      font-size: 0.8125rem;
      margin-bottom: 1rem;
      display: none;
    }
    .error.visible { display: block; }
    .success {
      background: #001a00;
      border: 1px solid #003b00;
      color: #22c55e;
      padding: 0.625rem 0.75rem;
      border-radius: 8px;
      font-size: 0.8125rem;
      margin-bottom: 1rem;
      display: none;
    }
    .success.visible { display: block; }
    .domain-hint {
      background: #0a1628;
      border: 1px solid #1e3a5f;
      color: #60a5fa;
      padding: 0.625rem 0.75rem;
      border-radius: 8px;
      font-size: 0.8125rem;
      margin-bottom: 1rem;
    }
    .domain-hint strong { color: #93bbfc; }
    .footer {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: #525252;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      ${logoHtml}
      <h1>${escapedAppName}</h1>
      <p>${magicOnly ? 'Sign in with a secure email link' : 'Sign in to your account'}</p>
    </div>
    <div class="card">
      ${allowSignup ? `
      <div class="tabs">
        <button class="tab${!isSignup ? ' active' : ''}" id="tab-signin" onclick="switchTab('signin')">Sign In</button>
        <button class="tab${isSignup ? ' active' : ''}" id="tab-signup" onclick="switchTab('signup')">Sign Up</button>
      </div>` : ''}
      <div id="error" class="error${escapedError ? ' visible' : ''}">${escapedError}</div>
      <div id="success" class="success"></div>${domainHint ? `
      <div id="domain-hint" class="domain-hint" style="display:${isSignup ? 'block' : 'none'}">Signup is limited to <strong>${escapeHtml(domainHint)}</strong> email addresses.</div>` : ''}
      <form id="auth-form" onsubmit="return handleSubmit(event)">
        <div class="field">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" required autocomplete="email">
        </div>${showPassword ? `
        <div class="field" id="password-field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Enter your password" minlength="6" autocomplete="current-password">
        </div>` : ''}
        <button type="submit" class="btn btn-primary" id="submit-btn">
          ${submitText}
        </button>
      </form>${showPassword && showMagicLink ? `
      <div class="divider">or</div>
      <button class="btn btn-secondary" id="magic-btn" onclick="handleMagicLink()">
        Send Magic Link
      </button>` : ''}
    </div>
    <div class="footer">
      Powered by Eve Horizon
    </div>
  </div>
  <script>
    const REDIRECT_TO = ${jsString(redirectTo)};
    const PROJECT_ID = ${jsString(context?.project_id ?? '')};
    const MAGIC_ONLY = ${magicOnly ? 'true' : 'false'};
    const ALLOW_SIGNUP = ${allowSignup ? 'true' : 'false'};
    const APP_SCOPED_MAGIC_LINK = ${appScopedMagicLink ? 'true' : 'false'};
    let currentTab = '${isSignup ? 'signup' : 'signin'}';

    function switchTab(tab) {
      if (!ALLOW_SIGNUP) return;
      currentTab = tab;
      document.getElementById('tab-signin')?.classList.toggle('active', tab === 'signin');
      document.getElementById('tab-signup')?.classList.toggle('active', tab === 'signup');
      document.getElementById('submit-btn').textContent = tab === 'signup' ? 'Create Account' : 'Sign In';
      const password = document.getElementById('password');
      if (password) password.autocomplete = tab === 'signup' ? 'new-password' : 'current-password';
      const hint = document.getElementById('domain-hint');
      if (hint) hint.style.display = tab === 'signup' ? 'block' : 'none';
      hideMessages();
    }

    function showError(msg) {
      const el = document.getElementById('error');
      el.textContent = msg;
      el.classList.add('visible');
      document.getElementById('success').classList.remove('visible');
    }

    function showSuccess(msg) {
      const el = document.getElementById('success');
      el.textContent = msg;
      el.classList.add('visible');
      document.getElementById('error').classList.remove('visible');
    }

    function hideMessages() {
      document.getElementById('error').classList.remove('visible');
      document.getElementById('success').classList.remove('visible');
    }

    function setLoading(btn, loading) {
      btn.disabled = loading;
      if (btn.id === 'submit-btn') {
        btn.textContent = loading
          ? (MAGIC_ONLY ? 'Sending...' : 'Please wait...')
          : (MAGIC_ONLY ? 'Send sign-in link' : currentTab === 'signup' ? 'Create Account' : 'Sign In');
      } else {
        btn.textContent = loading ? 'Sending...' : 'Send Magic Link';
      }
    }

    function goToCallback(accessToken, refreshToken) {
      const params = new URLSearchParams({
        access_token: accessToken,
        refresh_token: refreshToken,
        type: 'auth',
      });
      if (REDIRECT_TO) params.set('redirect_to', REDIRECT_TO);
      if (PROJECT_ID) params.set('project_id', PROJECT_ID);
      window.location.href = '/callback?' + params.toString();
    }

    async function handleSubmit(e) {
      e.preventDefault();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password')?.value || '';
      const btn = document.getElementById('submit-btn');

      if (!email) { showError('Email is required.'); return false; }
      if (MAGIC_ONLY) { await handleMagicLink(); return false; }
      if (!password || password.length < 6) { showError('Password must be at least 6 characters.'); return false; }

      setLoading(btn, true);
      hideMessages();

      try {
        if (currentTab === 'signup') {
          const res = await fetch('/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (!res.ok) { showError(data.error_description || data.msg || 'Signup failed.'); return false; }

          // If email confirmation is required, GoTrue returns a user with no access token
          if (data.access_token) {
            goToCallback(data.access_token, data.refresh_token);
          } else {
            showSuccess('Check your email to confirm your account.');
          }
        } else {
          const res = await fetch('/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (!res.ok) { showError(data.error_description || data.msg || 'Invalid credentials.'); return false; }
          goToCallback(data.access_token, data.refresh_token);
        }
      } catch (err) {
        showError('Network error. Please try again.');
      } finally {
        setLoading(btn, false);
      }
      return false;
    }

    async function handleMagicLink() {
      const email = document.getElementById('email').value.trim();
      const btn = MAGIC_ONLY ? document.getElementById('submit-btn') : document.getElementById('magic-btn');

      if (!email) { showError('Enter your email to receive a magic link.'); return; }
      if (!btn) { showError('Magic-link login is not available.'); return; }

      setLoading(btn, true);
      hideMessages();

      try {
        const res = await fetch('/auth/magiclink', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            ...(APP_SCOPED_MAGIC_LINK && PROJECT_ID ? { project_id: PROJECT_ID } : {}),
            ...(REDIRECT_TO ? { redirect_to: REDIRECT_TO } : {}),
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          showError(data.error_description || data.msg || 'Failed to send magic link.');
          return;
        }
        showSuccess('If your email has access, you will receive a sign-in link.');
      } catch (err) {
        showError('Network error. Please try again.');
      } finally {
        setLoading(btn, false);
      }
    }

    // Handle GoTrue hash-fragment redirects (magic link, invite, etc.)
    // GoTrue puts tokens in the URL hash: #access_token=...&refresh_token=...&type=...
    (function handleHashFragment() {
      const hash = window.location.hash;
      if (!hash || hash.length < 2) return;

      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const type = params.get('type') || 'auth';

      if (accessToken && refreshToken) {
        // Clear hash to avoid re-processing
        history.replaceState(null, '', window.location.pathname + window.location.search);
        // Preserve the type (e.g. 'invite') so /callback can handle it
        const cbParams = new URLSearchParams({
          access_token: accessToken,
          refresh_token: refreshToken,
          type: type,
        });
        if (REDIRECT_TO) cbParams.set('redirect_to', REDIRECT_TO);
        if (PROJECT_ID) cbParams.set('project_id', PROJECT_ID);
        window.location.href = '/callback?' + cbParams.toString();
      }
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Callback page HTML (for hash-fragment extraction from GoTrue redirects)
// ---------------------------------------------------------------------------

function callbackExtractorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Eve - Authenticating...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .msg { text-align: center; }
    .msg p { color: #737373; font-size: 0.875rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="msg">
    <h2>Authenticating...</h2>
    <p>Please wait while we complete your sign-in.</p>
  </div>
  <script>
    // GoTrue redirects with tokens in the hash fragment.
    // Extract them and forward to the server-side callback as query params.
    const hash = window.location.hash;
    const search = window.location.search;

    if (hash && hash.length > 1) {
      const hashParams = new URLSearchParams(hash.substring(1));
      const queryParams = new URLSearchParams(search);

      // GoTrue may surface a redemption failure via the hash fragment in the
      // implicit flow (e.g. #error=access_denied&error_code=otp_expired).
      // Forward the error to the server so /callback can redirect to /login
      // with a friendly message instead of infinite-spinning.
      const errorCode = hashParams.get('error_code') || hashParams.get('error');
      if (errorCode) {
        queryParams.set('error_code', errorCode);
        const description = hashParams.get('error_description');
        if (description) queryParams.set('error_description', description);
        window.location.replace('/callback?' + queryParams.toString());
        return;
      }

      // Merge hash params into query params
      for (const [key, value] of hashParams) {
        queryParams.set(key, value);
      }

      window.location.replace('/callback?' + queryParams.toString());
    }
    // If no hash, the page was loaded with query params already -- server handles it.
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();
app.use(cookieParser());
app.use(express.json());

// ---------------------------------------------------------------------------
// Magic-link confirmation interstitial (HEAD/GET/POST /m/:wrap)
//
// Eve-rendered magic-link and invite emails contain a URL of the form
//   https://sso/m/mlw_<26 base32>
// rather than the raw GoTrue verify URL. A corporate email-security scanner
// (Defender SafeLinks, Mimecast, Proofpoint, …) following the email URL hits
// this route via HEAD/GET; both are idempotent and do not consume the
// underlying GoTrue OTP. Only the user's browser POST (from the form button
// on the GET interstitial) calls /internal/auth/magic-link-wrap/consume,
// which is the single mutator and the only path that reveals the GoTrue
// action_link. See docs/plans/magic-link-confirmation-interstitial-plan.md.
// ---------------------------------------------------------------------------

function setWrapResponseHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function wrapExpiredHtml(opts: {
  kind: 'magic_link' | 'invite' | null;
  projectId: string | null;
  redirectTo: string | null;
  appName: string;
}): string {
  const escapedAppName = escapeHtml(opts.appName);
  const isMagic = opts.kind !== 'invite'; // default to magic-link copy for unknowns
  const heading = isMagic ? "This sign-in link can't be used" : "This invite link can't be used";
  const description = isMagic
    ? 'It may have already been used or expired. Request a new sign-in link to continue.'
    : 'It may have already been used or expired. Ask the person who invited you to send a new invite.';
  const cta = isMagic && opts.projectId ? `
        <a class="btn btn-primary" href="${escapeHtml(
          `/login${buildQuery({ project_id: opts.projectId, redirect_to: opts.redirectTo ?? undefined })}`,
        )}">Request a new sign-in link</a>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapedAppName} - Sign-in link unavailable</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 1rem;
    }
    .container { width: 100%; max-width: 440px; text-align: center; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 2rem; }
    h1 { font-size: 1.25rem; font-weight: 600; color: #fff; margin-bottom: 0.5rem; }
    p { color: #a3a3a3; font-size: 0.9375rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .btn { display: inline-block; padding: 0.625rem 1rem; border-radius: 8px; font-size: 0.875rem; font-weight: 500; text-decoration: none; }
    .btn-primary { background: #fff; color: #0a0a0a; }
    .footer { margin-top: 1.5rem; font-size: 0.75rem; color: #525252; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(description)}</p>${cta}
    </div>
    <div class="footer">Powered by Eve Horizon</div>
  </div>
</body>
</html>`;
}

function renderInterstitialHtml(opts: {
  kind: 'magic_link' | 'invite';
  appName: string;
  destinationHost: string | null;
  wrapToken: string;
  csrfNonce: string;
  branding: ProjectBranding | null;
}): string {
  const escapedAppName = escapeHtml(opts.appName);
  const isInvite = opts.kind === 'invite';
  const heading = isInvite
    ? `Accept invite to ${opts.appName}`
    : `Confirm sign-in to ${opts.appName}`;
  const buttonLabel = isInvite ? 'Accept invite' : 'Sign in';
  const destinationLine = opts.destinationHost
    ? `We'll send you to ${escapeHtml(opts.appName)} at <strong>${escapeHtml(opts.destinationHost)}</strong>.`
    : `We'll send you to ${escapeHtml(opts.appName)}.`;
  const helpText = isInvite
    ? 'This invite link can only be used once. If you didn\'t request it, you can close this tab.'
    : 'This sign-in link can only be used once. If you didn\'t request it, you can close this tab.';
  const primaryColor = opts.branding?.primary_color ?? '#ffffff';
  const primaryTextColor = primaryColor.toLowerCase() === '#ffffff' ? '#0a0a0a' : '#ffffff';
  const logoHtml = isHttpsUrl(opts.branding?.app_logo_url)
    ? `<img src="${escapeHtml(opts.branding.app_logo_url)}" alt="${escapedAppName}" referrerpolicy="no-referrer" style="display:block;max-width:160px;max-height:64px;margin:0 auto 0.75rem;">`
    : '';
  const action = `/m/${encodeURIComponent(opts.wrapToken)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(heading)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 1rem;
    }
    .container { width: 100%; max-width: 440px; }
    .logo { text-align: center; margin-bottom: 1.5rem; }
    .logo h1 { font-size: 1.5rem; font-weight: 700; color: #fff; letter-spacing: -0.025em; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 2rem; text-align: center; }
    .card h2 { font-size: 1.125rem; font-weight: 600; color: #fff; margin-bottom: 0.5rem; }
    .card p { color: #a3a3a3; font-size: 0.9375rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .card p strong { color: #e5e5e5; }
    .btn { width: 100%; padding: 0.75rem 1rem; border: none; border-radius: 8px; font-size: 0.9375rem; font-weight: 500; cursor: pointer; }
    .btn-primary { background: ${primaryColor}; color: ${primaryTextColor}; }
    .btn-primary:hover { opacity: 0.88; }
    .help { color: #525252; font-size: 0.8125rem; line-height: 1.5; margin-top: 1.25rem; }
    .footer { text-align: center; margin-top: 1.5rem; font-size: 0.75rem; color: #525252; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      ${logoHtml}
      <h1>${escapedAppName}</h1>
    </div>
    <div class="card">
      <h2>${escapeHtml(heading)}</h2>
      <p>${destinationLine}</p>
      <form method="POST" action="${escapeHtml(action)}" autocomplete="off">
        <input type="hidden" name="csrf" value="${escapeHtml(opts.csrfNonce)}">
        <button type="submit" class="btn btn-primary">${escapeHtml(buttonLabel)}</button>
      </form>
      <p class="help">${escapeHtml(helpText)}</p>
    </div>
    <div class="footer">Powered by Eve Horizon</div>
  </div>
</body>
</html>`;
}

app.head('/m/:wrap', async (req, res) => {
  setWrapResponseHeaders(res);
  const wrap = (req.params.wrap as string) || '';
  if (!isValidWrapToken(wrap)) {
    res.status(410).end();
    return;
  }
  const inspect = await internalApiPost<WrapInspectResponse>('/internal/auth/magic-link-wrap/inspect', { wrap_token: wrap });
  if (!inspect || !inspect.found) {
    res.status(410).end();
    return;
  }
  console.log(`[wrap.head] mlw=${wrap.slice(0, 12)}... project=${inspect.project_id ?? 'none'} get_count=${inspect.get_count} consumed=${inspect.consumed} expired=${inspect.expired}`);
  if (inspect.expired || inspect.consumed) {
    res.status(410).end();
    return;
  }
  res.status(200).end();
});

app.get('/m/:wrap', async (req, res) => {
  setWrapResponseHeaders(res);
  const wrap = (req.params.wrap as string) || '';
  if (!isValidWrapToken(wrap)) {
    res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
    return;
  }
  const inspect = await internalApiPost<WrapInspectResponse>('/internal/auth/magic-link-wrap/inspect', { wrap_token: wrap });
  if (!inspect || !inspect.found) {
    res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
    return;
  }
  console.log(`[wrap.get] mlw=${wrap.slice(0, 12)}... project=${inspect.project_id ?? 'none'} get_count=${inspect.get_count} consumed=${inspect.consumed} expired=${inspect.expired}`);

  const context = await fetchAppContext(inspect.project_id ?? undefined);
  const appName = context?.branding?.app_name?.trim() || 'Eve Horizon';
  const branding = context?.branding ?? null;

  if (inspect.expired || inspect.consumed) {
    res.status(410).type('html').send(wrapExpiredHtml({
      kind: inspect.kind,
      projectId: inspect.project_id,
      redirectTo: inspect.redirect_to,
      appName,
    }));
    return;
  }

  // Only echo the destination host once we've validated the redirect against
  // the project-aware allowlist. /callback remains the final authority, but
  // showing an unvalidated host on the interstitial would let an attacker
  // splash a trusted-looking page through their own URL.
  let destinationHost: string | null = null;
  if (inspect.redirect_to) {
    const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];
    if (isAllowedRedirect(inspect.redirect_to, { allowedOrigins })) {
      try { destinationHost = new URL(inspect.redirect_to).host; } catch { /* ignore */ }
    }
  }

  const csrfNonce = signWrapCsrf(wrap);
  res.status(200).type('html').send(renderInterstitialHtml({
    kind: inspect.kind,
    appName,
    destinationHost,
    wrapToken: wrap,
    csrfNonce,
    branding,
  }));
});

app.post('/m/:wrap', express.urlencoded({ extended: false }), async (req, res) => {
  setWrapResponseHeaders(res);
  const wrap = (req.params.wrap as string) || '';
  if (!isValidWrapToken(wrap)) {
    res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
    return;
  }
  const csrf = (req.body?.csrf as string) || '';
  if (!verifyWrapCsrf(wrap, csrf)) {
    console.warn(`[wrap.consume_failed] mlw=${wrap.slice(0, 12)}... reason=csrf_mismatch`);
    res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
    return;
  }
  const result = await internalApiPost<WrapConsumeResponse>('/internal/auth/magic-link-wrap/consume', { wrap_token: wrap });
  if (!result) {
    res.status(502).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
    return;
  }
  if (result.status !== 'ok') {
    console.warn(`[wrap.consume_failed] mlw=${wrap.slice(0, 12)}... reason=${result.status}`);
    // Re-inspect so we can render the right expired-page copy (magic-link vs
    // invite) and look up branding via the project. Inspect on a consumed
    // row is safe — it never mutates consumed_at.
    const inspectAfter = result.status === 'unknown'
      ? null
      : await internalApiPost<WrapInspectResponse>('/internal/auth/magic-link-wrap/inspect', { wrap_token: wrap });
    const kind = inspectAfter && inspectAfter.found ? inspectAfter.kind : null;
    const projectId = inspectAfter && inspectAfter.found ? inspectAfter.project_id : null;
    const redirectTo = inspectAfter && inspectAfter.found ? inspectAfter.redirect_to : null;
    const context = projectId ? await fetchAppContext(projectId) : null;
    const appName = context?.branding?.app_name?.trim() || 'Eve Horizon';
    res.status(410).type('html').send(wrapExpiredHtml({ kind, projectId, redirectTo, appName }));
    return;
  }
  console.log(`[wrap.consume] mlw=${wrap.slice(0, 12)}... project=${result.project_id ?? 'none'} kind=${result.kind}`);
  res.redirect(302, result.gotrue_action_link);
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

function landingPageHtml(opts: {
  redirectTo: string;
  projectId: string;
  signedIn: boolean;
  continueHref: string | null;
}): string {
  const { redirectTo, projectId, signedIn, continueHref } = opts;
  const continueLabel = signedIn ? 'Continue' : 'Continue to Sign In';
  const headline = signedIn ? 'Signed in' : 'Authenticating...';
  const body = signedIn
    ? 'You are signed in.'
    : 'Please wait while we complete your sign-in.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Eve - ${headline}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      width: 100%;
      max-width: 560px;
      border: 1px solid #262626;
      background: #141414;
      border-radius: 12px;
      padding: 1.5rem;
    }
    h2 { margin: 0 0 0.5rem; font-size: 1.25rem; color: #fff; }
    p  { margin: 0.5rem 0 0; color: #a3a3a3; line-height: 1.35; }
    code { color: #e5e5e5; }
    .btn {
      display: inline-block;
      margin-top: 1rem;
      padding: 0.625rem 0.875rem;
      border-radius: 10px;
      background: #fff;
      color: #0a0a0a;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.875rem;
      border: 0;
      cursor: pointer;
    }
    .btn-secondary {
      background: transparent;
      color: #a3a3a3;
      border: 1px solid #262626;
    }
    .btn-secondary:hover { background: #1a1a1a; color: #fff; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${headline}</h2>
    <p>${body}</p>
    ${continueHref ? `<a id="continue" class="btn" href="${escapeHtml(continueHref)}">${continueLabel}</a>` : ''}
    ${signedIn ? `<button id="signout" class="btn btn-secondary" onclick="signOut()">Sign out</button>` : ''}
  </div>
  <script>
    const REDIRECT_TO = ${jsString(redirectTo)};
    const PROJECT_ID = ${jsString(projectId)};

    // GoTrue redirects with tokens in the hash fragment.
    // Extract them and forward to the server-side callback as query params.
    const hash = window.location.hash;
    const search = window.location.search;
    if (hash && hash.length > 1) {
      const hashParams = new URLSearchParams(hash.substring(1));
      const queryParams = new URLSearchParams(search);
      for (const [key, value] of hashParams) queryParams.set(key, value);
      if (REDIRECT_TO) queryParams.set('redirect_to', REDIRECT_TO);
      if (PROJECT_ID) queryParams.set('project_id', PROJECT_ID);
      window.location.replace('/callback?' + queryParams.toString());
    }

    async function signOut() {
      const url = PROJECT_ID ? '/logout?project_id=' + encodeURIComponent(PROJECT_ID) : '/logout';
      try {
        await fetch(url, { method: 'POST', credentials: 'include' });
      } catch (err) {
        // best-effort
      }
      window.location.href = '/login';
    }
  </script>
  <noscript>
    <p style="margin-top: 1rem; color: #a3a3a3">
      JavaScript is required to complete sign-in automatically. Please use the
      Continue button above.
    </p>
  </noscript>
</body>
</html>`;
}

// Root handler: GoTrue verify/invite flows often redirect to the SSO base URL
// with tokens in the hash fragment. If the user already has an Eve session and
// the request carries a validated redirect target, send them straight through.
// Otherwise render a landing page that does not dead-end signed-in users back
// at /login.
app.get('/', async (req, res) => {
  const redirectTo = (req.query.redirect_to as string) || '';
  const projectId = (req.query.project_id as string) || '';
  const hasSession = Boolean(req.cookies?.eve_sso_rt);

  const context = projectId ? await fetchAppContext(projectId) : null;
  const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];

  // Signed-in user with a validated redirect target → straight through.
  if (hasSession && redirectTo && isAllowedRedirect(redirectTo, { allowedOrigins })) {
    res.redirect(302, redirectTo);
    return;
  }

  // Pick a sensible "Continue" target. Signed-in users without an explicit
  // redirect get a link to the single allowed origin (when there's exactly one),
  // or fall back to no Continue button rather than dead-ending at /login.
  let continueHref: string | null = null;
  if (hasSession) {
    if (allowedOrigins.length === 1) {
      continueHref = allowedOrigins[0];
    }
  } else {
    // Not signed in — render a Continue link that goes to /login, preserving
    // the redirect_to and project_id context.
    const params = new URLSearchParams();
    if (redirectTo) params.set('redirect_to', redirectTo);
    if (projectId) params.set('project_id', projectId);
    const query = params.toString();
    continueHref = '/login' + (query ? `?${query}` : '');
  }

  res.type('html').send(
    landingPageHtml({
      redirectTo,
      projectId,
      signedIn: hasSession,
      continueHref,
    }),
  );
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eve-sso' });
});

// ---------------------------------------------------------------------------
// GET /login
// ---------------------------------------------------------------------------

app.get('/login', async (req, res) => {
  const redirectTo = (req.query.redirect_to as string) || '';
  const projectId = (req.query.project_id as string) || '';
  const mode = (req.query.mode as string) || 'signin';
  const error = (req.query.error as string) || undefined;
  const context = await fetchAppContext(projectId);

  // If the user already has a session and the request carries a validated
  // redirect target, bypass the login form entirely. The form is a dead end
  // for a signed-in user otherwise.
  if (req.cookies?.eve_sso_rt && redirectTo) {
    const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];
    if (isAllowedRedirect(redirectTo, { allowedOrigins })) {
      res.redirect(302, redirectTo);
      return;
    }
  }

  res.type('html').send(loginPageHtml(redirectTo, mode, error, context));
});

// ---------------------------------------------------------------------------
// GET /callback
// ---------------------------------------------------------------------------

app.get('/callback', async (req, res) => {
  const accessToken = req.query.access_token as string | undefined;
  const refreshToken = req.query.refresh_token as string | undefined;
  const authType = (req.query.type as string) || '';
  let projectId = (req.query.project_id as string) || '';
  let redirectTo = (req.query.redirect_to as string) || '';

  // GoTrue surfaces redemption failures via ?error= / ?error_code= query
  // params (or the hash fragment — handled in callbackExtractorHtml). Surface
  // those to /login instead of letting the user spin on "Authenticating...".
  const errorCode = (req.query.error_code as string) || (req.query.error as string);
  if (errorCode) {
    const friendly = errorCode === 'otp_expired'
      ? 'This sign-in link has already been used or has expired. Please request a new sign-in link or ask for a new invite.'
      : 'Authentication failed. Please try again.';
    const loginUrl = `/login${buildQuery({
      error: friendly,
      error_code: errorCode,
      redirect_to: redirectTo,
      project_id: projectId,
    })}`;
    res.redirect(302, loginUrl);
    return;
  }

  // If tokens are not in query params, GoTrue may have put them in the hash.
  // Serve a page that extracts hash fragments and redirects to this endpoint
  // with them as query params.
  if (!accessToken || !refreshToken) {
    res.type('html').send(callbackExtractorHtml());
    return;
  }

  try {
    // Exchange the Supabase access token for an Eve RS256 token
    const exchangeResult = await exchangeForEveToken(accessToken);

    // Set root-domain cookies with the refresh token
    setSessionCookies(res, refreshToken);

    // If an invite was applied during exchange and it has a redirect_to,
    // use that as the redirect target (GoTrue strips nested redirect params).
    if (!redirectTo && exchangeResult.invite_redirect_to) {
      redirectTo = exchangeResult.invite_redirect_to;
    }

    // Recover project context from invite_app_context when GoTrue dropped it
    // from the callback query (common for the invite flow).
    if (!projectId && exchangeResult.invite_app_context?.project_id) {
      projectId = exchangeResult.invite_app_context.project_id;
    }

    // Fetch app context once so the redirect validator can consult the
    // project-declared allowlist.
    const context = await fetchAppContext(projectId);
    const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];

    // Validate redirect target against cluster + project-declared origins.
    if (!redirectTo || !isAllowedRedirect(redirectTo, { allowedOrigins })) {
      if (redirectTo) {
        console.warn(
          `[callback] Rejected redirect_to=${redirectTo} (project_id=${projectId || 'none'}, allowed=${allowedOrigins.join(',') || 'none'})`,
        );
      }
      // Default: redirect to the SSO broker root, using the request host
      const proto = SECURE_COOKIES ? 'https' : 'http';
      redirectTo = `${proto}://${req.hostname}/`;
    }

    if (exchangeResult.invite_org_id && isAllowedRedirect(redirectTo, { allowedOrigins })) {
      redirectTo = appendQueryParam(redirectTo, 'eve_org_id', exchangeResult.invite_org_id);
    }

    // For invite flows, redirect to the password-set page first.
    // The user's session is established (cookies set), but they need to
    // choose a password before being sent to the target app.
    if (authType === 'invite') {
      if (context?.auth?.invite_requires_password === false) {
        res.redirect(302, redirectTo);
        return;
      }
      const setPasswordUrl = `/set-password?redirect_to=${encodeURIComponent(redirectTo)}`;
      res.redirect(302, setPasswordUrl);
      return;
    }

    res.redirect(302, redirectTo);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    console.error('[callback] Exchange error:', message);
    const loginUrl = `/login${buildQuery({
      error: 'Authentication failed. Please try again.',
      redirect_to: redirectTo,
      project_id: projectId,
    })}`;
    res.redirect(302, loginUrl);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/token — proxy sign-in to GoTrue (same-origin, no CORS)
// ---------------------------------------------------------------------------

app.post('/auth/token', async (req, res) => {
  try {
    const gotrueRes = await fetch(`${SUPABASE_AUTH_URL}/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(req.body),
    });
    const data = await gotrueRes.text();
    res.status(gotrueRes.status).type('json').send(data);
  } catch (err) {
    console.error('[auth/token] Proxy error:', err);
    res.status(502).json({ error: 'Authentication service unavailable' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/signup — proxy sign-up to GoTrue (same-origin, no CORS)
// ---------------------------------------------------------------------------

app.post('/auth/signup', async (req, res) => {
  const email = req.body?.email;
  if (email && !isSignupEmailAllowed(email)) {
    const hint = SIGNUP_ALLOWED_DOMAINS.join(', ');
    res.status(422).json({ error: 'email_domain_not_allowed', msg: `Signup is restricted to: ${hint}` });
    return;
  }
  try {
    const gotrueRes = await fetch(`${SUPABASE_AUTH_URL}/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(req.body),
    });
    const data = await gotrueRes.text();
    res.status(gotrueRes.status).type('json').send(data);
  } catch (err) {
    console.error('[auth/signup] Proxy error:', err);
    res.status(502).json({ error: 'Authentication service unavailable' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/magiclink — proxy magic link to GoTrue (same-origin, no CORS)
// ---------------------------------------------------------------------------

app.post('/auth/magiclink', async (req, res) => {
  const email = req.body?.email;
  const projectId = req.body?.project_id;
  const redirectTo = req.body?.redirect_to;
  if (projectId) {
    try {
      const apiRes = await fetch(`${EVE_API_URL}/auth/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          project_id: projectId,
          ...(typeof redirectTo === 'string' && redirectTo ? { redirect_to: redirectTo } : {}),
        }),
      });
      const data = await apiRes.text();
      res.status(apiRes.status).type('json').send(data);
    } catch (err) {
      console.error('[auth/magiclink] Eve API proxy error:', err);
      res.status(502).json({ error: 'Authentication service unavailable' });
    }
    return;
  }

  if (email && !isSignupEmailAllowed(email)) {
    const hint = SIGNUP_ALLOWED_DOMAINS.join(', ');
    res.status(422).json({ error: 'email_domain_not_allowed', msg: `Signup is restricted to: ${hint}` });
    return;
  }
  try {
    const gotrueRes = await fetch(`${SUPABASE_AUTH_URL}/magiclink`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(req.body),
    });
    const data = await gotrueRes.text();
    res.status(gotrueRes.status).type('json').send(data);
  } catch (err) {
    console.error('[auth/magiclink] Proxy error:', err);
    res.status(502).json({ error: 'Authentication service unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /set-password — password-set page for invited users
// ---------------------------------------------------------------------------

function setPasswordPageHtml(redirectTo: string, error?: string): string {
  const escapedRedirect = redirectTo.replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const escapedError = error ? error.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eve - Set Password</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .container { width: 100%; max-width: 400px; }
    .logo { text-align: center; margin-bottom: 2rem; }
    .logo h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.025em; color: #fff; }
    .logo p { color: #737373; font-size: 0.875rem; margin-top: 0.25rem; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 2rem; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-size: 0.8125rem; font-weight: 500; color: #a3a3a3; margin-bottom: 0.375rem; }
    .field input { width: 100%; padding: 0.625rem 0.75rem; background: #0a0a0a; border: 1px solid #262626; border-radius: 8px; color: #fff; font-size: 0.875rem; outline: none; transition: border-color 0.15s; }
    .field input:focus { border-color: #525252; }
    .field input::placeholder { color: #525252; }
    .btn { width: 100%; padding: 0.625rem; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: background 0.15s, opacity 0.15s; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #fff; color: #0a0a0a; }
    .btn-primary:hover:not(:disabled) { background: #e5e5e5; }
    .error { background: #1a0000; border: 1px solid #3b0000; color: #ef4444; padding: 0.625rem 0.75rem; border-radius: 8px; font-size: 0.8125rem; margin-bottom: 1rem; display: none; }
    .error.visible { display: block; }
    .skip { display: block; text-align: center; margin-top: 1rem; color: #525252; font-size: 0.8125rem; cursor: pointer; border: none; background: none; text-decoration: underline; }
    .skip:hover { color: #737373; }
    .footer { text-align: center; margin-top: 1.5rem; font-size: 0.75rem; color: #525252; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>Eve</h1>
      <p>Welcome! Set a password for your account.</p>
    </div>
    <div class="card">
      <div id="error" class="error${escapedError ? ' visible' : ''}">${escapedError}</div>
      <form id="pw-form" onsubmit="return handleSetPassword(event)">
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Choose a password" minlength="6" autocomplete="new-password" required>
        </div>
        <div class="field">
          <label for="confirm">Confirm Password</label>
          <input type="password" id="confirm" name="confirm" placeholder="Confirm your password" minlength="6" autocomplete="new-password" required>
        </div>
        <button type="submit" class="btn btn-primary" id="submit-btn">Set Password</button>
      </form>
      <button class="skip" onclick="skipPassword()">Skip for now</button>
    </div>
    <div class="footer">Powered by Eve Horizon</div>
  </div>
  <script>
    const REDIRECT_TO = '${escapedRedirect}';

    function showError(msg) {
      const el = document.getElementById('error');
      el.textContent = msg;
      el.classList.add('visible');
    }

    async function handleSetPassword(e) {
      e.preventDefault();
      const pw = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      const btn = document.getElementById('submit-btn');

      if (pw.length < 6) { showError('Password must be at least 6 characters.'); return false; }
      if (pw !== confirm) { showError('Passwords do not match.'); return false; }

      btn.disabled = true;
      btn.textContent = 'Setting password...';

      try {
        const res = await fetch('/auth/update-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ password: pw }),
        });
        const data = await res.json();
        if (!res.ok) {
          showError(data.error || 'Failed to set password.');
          btn.disabled = false;
          btn.textContent = 'Set Password';
          return false;
        }
        // Password set — redirect to target app
        window.location.href = REDIRECT_TO || '/';
      } catch (err) {
        showError('Network error. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Set Password';
      }
      return false;
    }

    function skipPassword() {
      window.location.href = REDIRECT_TO || '/';
    }
  </script>
</body>
</html>`;
}

app.get('/set-password', (req, res) => {
  const redirectTo = (req.query.redirect_to as string) || '';
  const error = (req.query.error as string) || undefined;
  res.type('html').send(setPasswordPageHtml(redirectTo, error));
});

// ---------------------------------------------------------------------------
// POST /auth/update-password — set password using session refresh token
// ---------------------------------------------------------------------------

app.post('/auth/update-password', async (req, res) => {
  const refreshToken = req.cookies?.eve_sso_rt;
  if (!refreshToken) {
    res.status(401).json({ error: 'No session. Please start the invite flow again.' });
    return;
  }

  const { password } = req.body;
  if (!password || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' });
    return;
  }

  try {
    // Refresh the Supabase session to get a valid access token
    const supabase = await refreshSupabaseSession(refreshToken);

    // Update the refresh token cookie (GoTrue may rotate it)
    setSessionCookies(res, supabase.refresh_token);

    // Set password via GoTrue PUT /user
    const gotrueRes = await fetch(`${SUPABASE_AUTH_URL}/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabase.access_token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ password }),
    });

    if (!gotrueRes.ok) {
      const errData = await gotrueRes.text();
      console.error('[auth/update-password] GoTrue error:', gotrueRes.status, errData);
      res.status(gotrueRes.status).json({ error: 'Failed to set password. Please try again.' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update password';
    console.error('[auth/update-password] Error:', message);
    res.status(500).json({ error: 'Failed to set password. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// OPTIONS + GET /session  (CORS-enabled with credentials)
// ---------------------------------------------------------------------------

async function applyCorsHeaders(req: express.Request, res: express.Response): Promise<boolean> {
  const origin = req.headers.origin;
  // Same-origin requests may omit the Origin header. In that case, CORS is not
  // relevant and we should allow the request to proceed.
  if (!origin) return true;

  // Cluster-domain origins are always allowed (no project context needed).
  let parsed: URL | null = null;
  try {
    parsed = new URL(origin);
  } catch {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  if (isClusterDomainHost(parsed.hostname)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return true;
  }

  // Non-cluster origins must declare their project context so the SSO can
  // consult the project-scoped allowlist. Without a project, we cannot trust
  // any external origin.
  const projectId = (req.query.project_id as string) || '';
  if (!projectId) {
    res.status(403).json({ error: 'Origin not allowed (project_id required for cross-domain requests)' });
    return false;
  }

  const context = await fetchAppContext(projectId);
  const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];
  if (!isAllowedOrigin(origin, { allowedOrigins })) {
    console.warn(
      `[cors] Rejected origin=${origin} (project_id=${projectId}, allowed=${allowedOrigins.join(',') || 'none'})`,
    );
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  return true;
}

app.options('/session', async (req, res) => {
  if (await applyCorsHeaders(req, res)) {
    res.status(204).end();
  }
});

app.get('/session', async (req, res) => {
  if (!await applyCorsHeaders(req, res)) return;

  const refreshToken = req.cookies?.eve_sso_rt;
  if (!refreshToken) {
    res.status(401).json({ error: 'No session' });
    return;
  }

  try {
    // Refresh the Supabase session
    const supabase = await refreshSupabaseSession(refreshToken);

    // Update the refresh token cookie (GoTrue may rotate it)
    setSessionCookies(res, supabase.refresh_token);

    // Exchange for Eve RS256 token
    const eve = await exchangeForEveToken(supabase.access_token);

    // Decode user info from the Supabase token for convenience
    const claims = decodeJwtPayload(supabase.access_token);
    const email = (claims?.email as string) || '';

    res.json({
      access_token: eve.access_token,
      expires_at: eve.expires_at,
      user: {
        id: eve.user_id,
        email,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Session refresh failed';
    console.error('[session] Error:', message);

    // If refresh fails, the session is invalid -- clear cookies
    clearSessionCookies(res);
    res.status(401).json({ error: 'Session expired' });
  }
});

// ---------------------------------------------------------------------------
// OPTIONS + POST /logout  (CORS-enabled)
// ---------------------------------------------------------------------------

app.options('/logout', async (req, res) => {
  if (await applyCorsHeaders(req, res)) {
    res.status(204).end();
  }
});

app.post('/logout', async (req, res) => {
  if (!await applyCorsHeaders(req, res)) return;

  clearSessionCookies(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[eve-sso] Listening on port ${PORT}`);
  console.log(`[eve-sso] Domain: ${EVE_DEFAULT_DOMAIN}`);
  console.log(`[eve-sso] GoTrue (internal): ${SUPABASE_AUTH_URL}`);
  console.log(`[eve-sso] GoTrue (proxied via /auth/*)`);

  console.log(`[eve-sso] Eve API: ${EVE_API_URL}`);
  console.log(`[eve-sso] Secure cookies: ${SECURE_COOKIES} (SameSite=${COOKIE_SAMESITE})`);
  console.log(`[eve-sso] Signup domain restriction: ${SIGNUP_ALLOWED_DOMAINS.length > 0 ? SIGNUP_ALLOWED_DOMAINS.join(', ') : 'none (all domains allowed)'}`);
});

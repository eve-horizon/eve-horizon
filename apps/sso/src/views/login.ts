import { SIGNUP_ALLOWED_DOMAINS } from '../config.js';
import type { SsoLoginContext } from '../types.js';
import { escapeHtml, isHttpsUrl, jsString, pageChrome } from './chrome.js';

export function loginPageHtml(
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

  const head = `  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedAppName} - Sign In</title>`;

  const css = `    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
    }`;

  const body = `  <div class="container">
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
  </script>`;

  return pageChrome(body, { head, css });
}

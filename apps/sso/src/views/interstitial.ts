import type { ProjectBranding } from '../types.js';
import { escapeHtml, isHttpsUrl, pageChrome } from './chrome.js';

export function renderInterstitialHtml(opts: {
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

  const head = `  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(heading)}</title>`;

  const css = `    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
    .footer { text-align: center; margin-top: 1.5rem; font-size: 0.75rem; color: #525252; }`;

  const body = `  <div class="container">
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
  </div>`;

  return pageChrome(body, { head, css });
}

import { buildQuery } from '../urls.js';
import { escapeHtml, pageChrome } from './chrome.js';

export function wrapExpiredHtml(opts: {
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

  const head = `  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapedAppName} - Sign-in link unavailable</title>`;

  const css = `    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
    .footer { margin-top: 1.5rem; font-size: 0.75rem; color: #525252; }`;

  const body = `  <div class="container">
    <div class="card">
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(description)}</p>${cta}
    </div>
    <div class="footer">Powered by Eve Horizon</div>
  </div>`;

  return pageChrome(body, { head, css });
}

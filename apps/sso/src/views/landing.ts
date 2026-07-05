import { escapeHtml, jsString, pageChrome } from './chrome.js';

export function landingPageHtml(opts: {
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

  const head = `  <title>Eve - ${headline}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">`;

  const css = `    body {
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
    .btn-secondary:hover { background: #1a1a1a; color: #fff; }`;

  const bodyHtml = `  <div class="card">
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
  </noscript>`;

  return pageChrome(bodyHtml, { head, css });
}

import { pageChrome } from './chrome.js';

export function callbackExtractorHtml(): string {
  const head = `  <title>Eve - Authenticating...</title>`;

  const css = `    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .msg { text-align: center; }
    .msg p { color: #737373; font-size: 0.875rem; margin-top: 0.5rem; }`;

  const body = `  <div class="msg">
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
  </script>`;

  return pageChrome(body, { head, css });
}

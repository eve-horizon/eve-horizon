import { pageChrome } from './chrome.js';

export function setPasswordPageHtml(redirectTo: string, error?: string): string {
  const escapedRedirect = redirectTo.replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const escapedError = error ? error.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';

  const head = `  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eve - Set Password</title>`;

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
    .footer { text-align: center; margin-top: 1.5rem; font-size: 0.75rem; color: #525252; }`;

  const body = `  <div class="container">
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
  </script>`;

  return pageChrome(body, { head, css });
}

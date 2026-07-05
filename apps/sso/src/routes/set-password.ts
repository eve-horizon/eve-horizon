import type { Express } from 'express';
import { SUPABASE_ANON_KEY, SUPABASE_AUTH_URL } from '../config.js';
import { setSessionCookies } from '../cookies.js';
import { refreshSupabaseSession } from '../gotrue-client.js';
import { setPasswordPageHtml } from '../views/set-password.js';

export function registerSetPasswordRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // GET /set-password — password-set page for invited users
  // -------------------------------------------------------------------------

  app.get('/set-password', (req, res) => {
    const redirectTo = (req.query.redirect_to as string) || '';
    const error = (req.query.error as string) || undefined;
    res.type('html').send(setPasswordPageHtml(redirectTo, error));
  });

  // -------------------------------------------------------------------------
  // POST /auth/update-password — set password using session refresh token
  // -------------------------------------------------------------------------

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
}

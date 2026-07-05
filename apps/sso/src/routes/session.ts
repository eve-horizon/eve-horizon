import type { Express } from 'express';
import { clearSessionCookies, setSessionCookies } from '../cookies.js';
import { decodeJwtPayload, exchangeForEveToken, refreshSupabaseSession } from '../gotrue-client.js';
import { applyCorsHeaders } from '../security.js';

export function registerSessionRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // OPTIONS + GET /session  (CORS-enabled with credentials)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // OPTIONS + POST /logout  (CORS-enabled)
  // -------------------------------------------------------------------------

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
}

import type { Express } from 'express';
import { SECURE_COOKIES } from '../config.js';
import { setSessionCookies } from '../cookies.js';
import { exchangeForEveToken, fetchAppContext } from '../gotrue-client.js';
import { isAllowedRedirect } from '../security.js';
import { appendQueryParam, buildQuery } from '../urls.js';
import { callbackExtractorHtml } from '../views/callback-extractor.js';

export function registerCallbackRoutes(app: Express): void {
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
}

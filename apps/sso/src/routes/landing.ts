import type { Express } from 'express';
import { fetchAppContext } from '../gotrue-client.js';
import { isAllowedRedirect } from '../security.js';
import { landingPageHtml } from '../views/landing.js';

export function registerLandingRoutes(app: Express): void {
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
}

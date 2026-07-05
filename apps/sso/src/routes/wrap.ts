import express from 'express';
import type { Express } from 'express';
import { fetchAppContext, internalApiPost } from '../gotrue-client.js';
import { isAllowedRedirect, isValidWrapToken, signWrapCsrf, verifyWrapCsrf } from '../security.js';
import type { WrapConsumeResponse, WrapInspectResponse } from '../types.js';
import { renderInterstitialHtml } from '../views/interstitial.js';
import { wrapExpiredHtml } from '../views/wrap-expired.js';

// ---------------------------------------------------------------------------
// Magic-link confirmation interstitial (HEAD/GET/POST /m/:wrap)
//
// Eve-rendered magic-link and invite emails contain a URL of the form
//   https://sso/m/mlw_<26 base32>
// rather than the raw GoTrue verify URL. A corporate email-security scanner
// (Defender SafeLinks, Mimecast, Proofpoint, …) following the email URL hits
// this route via HEAD/GET; both are idempotent and do not consume the
// underlying GoTrue OTP. Only the user's browser POST (from the form button
// on the GET interstitial) calls /internal/auth/magic-link-wrap/consume,
// which is the single mutator and the only path that reveals the GoTrue
// action_link. See docs/plans/magic-link-confirmation-interstitial-plan.md.
// ---------------------------------------------------------------------------

function setWrapResponseHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

export function registerWrapRoutes(app: Express): void {
  app.head('/m/:wrap', async (req, res) => {
    setWrapResponseHeaders(res);
    const wrap = (req.params.wrap as string) || '';
    if (!isValidWrapToken(wrap)) {
      res.status(410).end();
      return;
    }
    const inspect = await internalApiPost<WrapInspectResponse>('/internal/auth/magic-link-wrap/inspect', { wrap_token: wrap });
    if (!inspect || !inspect.found) {
      res.status(410).end();
      return;
    }
    console.log(`[wrap.head] mlw=${wrap.slice(0, 12)}... project=${inspect.project_id ?? 'none'} get_count=${inspect.get_count} consumed=${inspect.consumed} expired=${inspect.expired}`);
    if (inspect.expired || inspect.consumed) {
      res.status(410).end();
      return;
    }
    res.status(200).end();
  });

  app.get('/m/:wrap', async (req, res) => {
    setWrapResponseHeaders(res);
    const wrap = (req.params.wrap as string) || '';
    if (!isValidWrapToken(wrap)) {
      res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
      return;
    }
    const inspect = await internalApiPost<WrapInspectResponse>('/internal/auth/magic-link-wrap/inspect', { wrap_token: wrap });
    if (!inspect || !inspect.found) {
      res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
      return;
    }
    console.log(`[wrap.get] mlw=${wrap.slice(0, 12)}... project=${inspect.project_id ?? 'none'} get_count=${inspect.get_count} consumed=${inspect.consumed} expired=${inspect.expired}`);

    const context = await fetchAppContext(inspect.project_id ?? undefined);
    const appName = context?.branding?.app_name?.trim() || 'Eve Horizon';
    const branding = context?.branding ?? null;

    if (inspect.expired || inspect.consumed) {
      res.status(410).type('html').send(wrapExpiredHtml({
        kind: inspect.kind,
        projectId: inspect.project_id,
        redirectTo: inspect.redirect_to,
        appName,
      }));
      return;
    }

    // Only echo the destination host once we've validated the redirect against
    // the project-aware allowlist. /callback remains the final authority, but
    // showing an unvalidated host on the interstitial would let an attacker
    // splash a trusted-looking page through their own URL.
    let destinationHost: string | null = null;
    if (inspect.redirect_to) {
      const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];
      if (isAllowedRedirect(inspect.redirect_to, { allowedOrigins })) {
        try { destinationHost = new URL(inspect.redirect_to).host; } catch { /* ignore */ }
      }
    }

    const csrfNonce = signWrapCsrf(wrap);
    res.status(200).type('html').send(renderInterstitialHtml({
      kind: inspect.kind,
      appName,
      destinationHost,
      wrapToken: wrap,
      csrfNonce,
      branding,
    }));
  });

  app.post('/m/:wrap', express.urlencoded({ extended: false }), async (req, res) => {
    setWrapResponseHeaders(res);
    const wrap = (req.params.wrap as string) || '';
    if (!isValidWrapToken(wrap)) {
      res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
      return;
    }
    const csrf = (req.body?.csrf as string) || '';
    if (!verifyWrapCsrf(wrap, csrf)) {
      console.warn(`[wrap.consume_failed] mlw=${wrap.slice(0, 12)}... reason=csrf_mismatch`);
      res.status(410).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
      return;
    }
    const result = await internalApiPost<WrapConsumeResponse>('/internal/auth/magic-link-wrap/consume', { wrap_token: wrap });
    if (!result) {
      res.status(502).type('html').send(wrapExpiredHtml({ kind: null, projectId: null, redirectTo: null, appName: 'Eve Horizon' }));
      return;
    }
    if (result.status !== 'ok') {
      console.warn(`[wrap.consume_failed] mlw=${wrap.slice(0, 12)}... reason=${result.status}`);
      // Re-inspect so we can render the right expired-page copy (magic-link vs
      // invite) and look up branding via the project. Inspect on a consumed
      // row is safe — it never mutates consumed_at.
      const inspectAfter = result.status === 'unknown'
        ? null
        : await internalApiPost<WrapInspectResponse>('/internal/auth/magic-link-wrap/inspect', { wrap_token: wrap });
      const kind = inspectAfter && inspectAfter.found ? inspectAfter.kind : null;
      const projectId = inspectAfter && inspectAfter.found ? inspectAfter.project_id : null;
      const redirectTo = inspectAfter && inspectAfter.found ? inspectAfter.redirect_to : null;
      const context = projectId ? await fetchAppContext(projectId) : null;
      const appName = context?.branding?.app_name?.trim() || 'Eve Horizon';
      res.status(410).type('html').send(wrapExpiredHtml({ kind, projectId, redirectTo, appName }));
      return;
    }
    console.log(`[wrap.consume] mlw=${wrap.slice(0, 12)}... project=${result.project_id ?? 'none'} kind=${result.kind}`);
    res.redirect(302, result.gotrue_action_link);
  });
}

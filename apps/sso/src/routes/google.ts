import type { Express, Response } from 'express';
import { GOOGLE_OAUTH_CONFIG, SECURE_COOKIES, type GoogleOauthConfig } from '../config.js';
import { setSessionCookies } from '../cookies.js';
import {
  GOOGLE_OAUTH_COOKIE,
  createGoogleOauthTransaction,
  defaultGoogleOauthEndpoints,
  exchangeGoogleForEveToken,
  exchangeGooglePkceCode,
  fetchGoogleProjectContext,
  googleAuthorizeUrl,
  googleOauthLimits,
  isGoogleEnabledUpstream,
  isGoogleOptedIn,
  isGoogleRedirectAllowed,
  scalarQuery,
  sealGoogleOauthTransaction,
  statesMatch,
  unsealGoogleOauthTransaction,
  type GoogleOauthEndpoints,
  type GoogleOauthTransaction,
} from '../google-oauth.js';

const FRIENDLY_ERROR = 'Google sign-in failed. Please try again.';

type GoogleRouteDeps = {
  config?: GoogleOauthConfig | null;
  endpoints?: GoogleOauthEndpoints;
  now?: () => number;
};

function transactionCookieOptions() {
  return {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'lax' as const,
    path: '/',
  };
}

function transactionCookieSetOptions() {
  return { ...transactionCookieOptions(), maxAge: 5 * 60 * 1000 };
}

function applyOAuthResponseHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function loginFailure(res: Response, transaction?: GoogleOauthTransaction): void {
  const query = new URLSearchParams({ error: FRIENDLY_ERROR });
  if (transaction) {
    query.set('project_id', transaction.projectId);
    query.set('redirect_to', transaction.redirectTo);
  }
  res.redirect(302, `/login?${query.toString()}`);
}

async function revalidateTransaction(transaction: GoogleOauthTransaction, endpoints: GoogleOauthEndpoints): Promise<boolean> {
  const context = await fetchGoogleProjectContext(transaction.projectId, endpoints);
  return isGoogleOptedIn(context, transaction.projectId)
    && isGoogleRedirectAllowed(transaction.redirectTo, context.auth.allowed_redirect_origins ?? []);
}

async function retryWithValidatedContext(res: Response, transaction: GoogleOauthTransaction | null, endpoints: GoogleOauthEndpoints): Promise<void> {
  if (transaction && await revalidateTransaction(transaction, endpoints)) {
    loginFailure(res, transaction);
    return;
  }
  loginFailure(res);
}

export function registerGoogleRoutes(app: Express, deps: GoogleRouteDeps = {}): void {
  const config = deps.config === undefined ? GOOGLE_OAUTH_CONFIG : deps.config;
  const endpoints = deps.endpoints ?? defaultGoogleOauthEndpoints;
  const now = deps.now ?? Date.now;

  app.get('/auth/google/start', async (req, res) => {
    applyOAuthResponseHeaders(res);
    if (!config) {
      res.status(404).end();
      return;
    }
    const projectId = scalarQuery(req.query.project_id, googleOauthLimits.projectId);
    const requestedRedirect = req.query.redirect_to === undefined
      ? config.ssoUrl.toString()
      : scalarQuery(req.query.redirect_to, googleOauthLimits.redirectTo);
    if (!projectId || !requestedRedirect) {
      res.status(400).send('Invalid sign-in request');
      return;
    }
    const context = await fetchGoogleProjectContext(projectId, endpoints);
    if (!isGoogleOptedIn(context, projectId)
      || !isGoogleRedirectAllowed(requestedRedirect, context.auth.allowed_redirect_origins ?? [])
      || !await isGoogleEnabledUpstream(endpoints)) {
      res.status(400).send('Google sign-in is unavailable');
      return;
    }
    const transaction = createGoogleOauthTransaction(projectId, requestedRedirect, now());
    try {
      res.cookie(GOOGLE_OAUTH_COOKIE, sealGoogleOauthTransaction(transaction, config.stateKey), transactionCookieSetOptions());
      res.redirect(302, googleAuthorizeUrl(config, transaction));
    } catch {
      res.status(500).send('Google sign-in is unavailable');
    }
  });

  app.get('/auth/google/callback', async (req, res) => {
    applyOAuthResponseHeaders(res);
    if (!config) {
      res.status(404).end();
      return;
    }
    const state = scalarQuery(req.query.state, googleOauthLimits.state);
    const code = scalarQuery(req.query.code, googleOauthLimits.code);
    const cookie = req.cookies?.[GOOGLE_OAUTH_COOKIE];
    const transaction = unsealGoogleOauthTransaction(cookie, config.stateKey, now());
    const retryTransaction = transaction ?? unsealGoogleOauthTransaction(cookie, config.stateKey, now(), { allowExpired: true });
    if (!state || !transaction || !statesMatch(transaction.state, state)) {
      // A mismatched state can be an older tab returning after a newer tab has
      // started. Keep a valid latest transaction intact; only tampered/expired
      // cookies are cleared.
      if (!transaction) res.clearCookie(GOOGLE_OAUTH_COOKIE, transactionCookieOptions());
      await retryWithValidatedContext(res, retryTransaction, endpoints);
      return;
    }
    if (!code) {
      res.clearCookie(GOOGLE_OAUTH_COOKIE, transactionCookieOptions());
      await retryWithValidatedContext(res, transaction, endpoints);
      return;
    }

    // Clear the browser transaction before upstream calls. GoTrue's one-use
    // authorization code also rejects replay of a captured cookie and code.
    res.clearCookie(GOOGLE_OAUTH_COOKIE, transactionCookieOptions());
    if (!await revalidateTransaction(transaction, endpoints)) {
      loginFailure(res);
      return;
    }
    const supabase = await exchangeGooglePkceCode(code, transaction.verifier, endpoints);
    if (!supabase) {
      await retryWithValidatedContext(res, transaction, endpoints);
      return;
    }
    const eve = await exchangeGoogleForEveToken(supabase.accessToken, transaction.projectId, endpoints);
    if (!eve || !await revalidateTransaction(transaction, endpoints)) {
      await retryWithValidatedContext(res, transaction, endpoints);
      return;
    }
    setSessionCookies(res, supabase.refreshToken);
    res.redirect(302, transaction.redirectTo);
  });
}

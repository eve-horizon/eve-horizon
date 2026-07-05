import express from 'express';
import { COOKIE_SAMESITE, EVE_DEFAULT_DOMAIN, SECURE_COOKIES } from './config.js';

/** Set root-domain session cookies after successful auth. */
export function setSessionCookies(
  res: express.Response,
  refreshToken: string,
): void {
  const cookieDomain = `.${EVE_DEFAULT_DOMAIN}`;

  // httpOnly refresh token cookie -- never accessible to JavaScript
  res.cookie('eve_sso_rt', refreshToken, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: COOKIE_SAMESITE,
    path: '/',
    domain: cookieDomain,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });

  // UX hint cookie -- non-httpOnly so apps can detect presence
  res.cookie('eve_sso', '1', {
    httpOnly: false,
    secure: SECURE_COOKIES,
    sameSite: COOKIE_SAMESITE,
    path: '/',
    domain: cookieDomain,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/** Clear session cookies. */
export function clearSessionCookies(res: express.Response): void {
  const cookieDomain = `.${EVE_DEFAULT_DOMAIN}`;
  res.clearCookie('eve_sso_rt', { path: '/', domain: cookieDomain });
  res.clearCookie('eve_sso', { path: '/', domain: cookieDomain });
}

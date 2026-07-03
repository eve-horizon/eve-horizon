# SSO Architecture

> **What**: GoTrue-backed web auth broker for the platform and tenant apps.
> **Why**: One hosted login surface (passwords, magic links, sessions) shared by every app, with
> per-project branding, redirect allowlists, and org-access policy enforced centrally.

## Overview

A single-file Fastify service (`src/main.ts`) that proxies GoTrue (Supabase-compatible) auth,
exchanges Supabase tokens for Eve RS256 tokens via the API, and manages root-domain session cookies
(`SameSite=None` when `EVE_SSO_SECURE_COOKIES=true`, else `Lax` for local k3d).

## Routes

- `GET /login`, `POST /auth/token`, `POST /auth/signup`, `POST /auth/magiclink` — login surface
- `GET|POST /m/:wrap` — magic-link interstitial (CSRF-signed wrap tokens; expiry page)
- `GET /set-password`, `POST /auth/update-password` — invite/password flows
- `GET /session` — cookie → token probe used by app SDKs
- `GET /callback`, `POST /logout`, `GET /health`

## Key Decisions (Why)

- **Redirect + CORS allowlists** combine cluster-level origins with project-declared
  `x-eve.auth.allowed_redirect_origins` — custom-domain apps opt in via manifest.
- **Policy lives in the API** — `domain_signup` / org-access rule evaluation happens in the API's
  auth service; SSO calls it via the internal API.

## Navigation

- Auth: [docs/system/auth.md](../../docs/system/auth.md)
- App SSO integration: [docs/system/app-sso-integration.md](../../docs/system/app-sso-integration.md)

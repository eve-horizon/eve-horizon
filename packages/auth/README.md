# @eve-horizon/auth

Backend auth SDK for Eve-compatible apps. Verify Eve tokens and check org membership with Express middleware.

## Install

```bash
npm install @eve-horizon/auth
```

## Quick Start

```typescript
import { eveUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

// Parse tokens and check org membership (non-blocking)
app.use(eveUserAuth());

// Serve auth discovery config
app.get('/auth/config', eveAuthConfig());

// Protected route
app.get('/auth/me', eveAuthGuard(), (req, res) => res.json(req.eveUser));

// Protect all API routes
app.use('/api', eveAuthGuard());
```

For apps that use Eve app-org access policies, switch to `eveAppUserAuth()`:

```typescript
import { eveAppUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

app.use(eveAppUserAuth());
app.get('/auth/config', eveAuthConfig());
app.use('/api', eveAuthGuard());
```

## Environment Variables

Set automatically when deployed to Eve:

| Variable | Purpose |
|----------|---------|
| `EVE_API_URL` | JWKS fetch + remote token verification |
| `EVE_ORG_ID` | Org membership check |
| `EVE_SSO_URL` | Auth config discovery |
| `EVE_PROJECT_ID` | App-scoped org access lookup |

## Docs

Full reference: [Eve Auth SDK Documentation](https://github.com/eve-horizon/eve-horizon/blob/main/docs/system/eve-auth-sdk.md)

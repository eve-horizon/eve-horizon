# Eve SDK

> The app developer's entry point to Eve authentication and embedded conversations.

SDK packages that eliminate auth and embedded chat boilerplate in Eve-compatible apps:

| Package | Runtime | Purpose |
|---------|---------|---------|
| `@eve-horizon/auth` | Node.js (Express/NestJS) | Token verification, org membership, auth config |
| `@eve-horizon/auth-react` | Browser (React) | SSO session management, login UI, token cache |
| `@eve-horizon/chat` | Browser/Node.js | Embedded conversation client, bearer fetch, SSE stream parser |
| `@eve-horizon/chat-react` | Browser (React) | Conversation provider, hook, and minimal panes |

## Install

```bash
# Backend
npm install @eve-horizon/auth

# Frontend
npm install @eve-horizon/auth-react

# Embedded conversations
npm install @eve-horizon/chat @eve-horizon/chat-react
```

## Backend Setup

```typescript
import { eveUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

// Parse tokens, check org membership (non-blocking)
app.use(eveUserAuth());

// Serve auth discovery config
app.get('/auth/config', eveAuthConfig());

// Protected route
app.get('/auth/me', eveAuthGuard(), (req, res) => res.json(req.eveUser));

// Protect all API routes
app.use('/api', eveAuthGuard());
```

## Frontend Setup

```tsx
import { EveAuthProvider, EveLoginGate, useEveAuth } from '@eve-horizon/auth-react';

function App() {
  return (
    <EveAuthProvider apiUrl="/api">
      <EveLoginGate>
        <Dashboard />
      </EveLoginGate>
    </EveAuthProvider>
  );
}

function Dashboard() {
  const { user, logout } = useEveAuth();
  return <div>Welcome {user?.email} <button onClick={logout}>Sign out</button></div>;
}
```

## How Token Flow Works

1. User visits app -- `EveAuthProvider` checks `sessionStorage` for cached token
2. No cached token -- probes SSO broker `/session` (root-domain cookie)
3. SSO session exists -- gets fresh Eve RS256 token, caches in `sessionStorage`
4. No SSO session -- shows login form (SSO redirect or token paste)
5. All API requests include `Authorization: Bearer <token>` header

## Environment Variables

Auto-injected by the Eve deployer into every deployed app:

| Variable | Used By | Purpose |
|----------|---------|---------|
| `EVE_API_URL` | `@eve-horizon/auth` | JWKS fetch, remote token verification |
| `EVE_ORG_ID` | `@eve-horizon/auth` | Org membership check |
| `EVE_SSO_URL` | Both | Auth config discovery, SSO session probe |
| `EVE_PUBLIC_API_URL` | Both | Public-facing API URL (optional) |

No manual configuration needed when deployed to Eve.

## Common Scenarios

### Backend-Only API

For APIs that only serve agent jobs (no browser users):

```typescript
import { eveAuthMiddleware } from '@eve-horizon/auth';

// Blocking — returns 401 on any auth failure
app.use('/api', eveAuthMiddleware({ strategy: 'local' }));

// Access claims via req.agent
app.get('/api/data', (req, res) => {
  console.log(req.agent.project_id, req.agent.job_id);
});
```

### Fullstack React App

Combine both packages for SSO login with protected API routes:

```typescript
// Backend
app.use(eveUserAuth());
app.get('/auth/config', eveAuthConfig());
app.get('/auth/me', eveAuthGuard(), (req, res) => res.json(req.eveUser));
app.use('/api', eveAuthGuard());
```

```tsx
// Frontend
import { EveAuthProvider, EveLoginGate, createEveClient } from '@eve-horizon/auth-react';

const client = createEveClient('/api');
const res = await client.fetch('/data');
```

### Embedded Conversation Pane

Use Eve threads as the durable conversation record for an app-owned object:

```tsx
import { EveConversationProvider, EveConversationDefaultPane } from '@eve-horizon/chat-react';

function DesignerChat({ projectId, conversationId }: { projectId: string; conversationId: string }) {
  const { token } = useSession();
  return (
    <EveConversationProvider
      baseUrl="/api/eve"
      projectId={projectId}
      appKey={`open-design:${projectId}:${conversationId}`}
      appId="open-design"
      getToken={() => token}
    >
      <EveConversationDefaultPane />
    </EveConversationProvider>
  );
}
```

Backend-proxied apps can use `@eve-horizon/chat/server` with a service token to enrich or reject turns before forwarding them to Eve.

Conversation streams are fetch-based SSE. Each `message` or `progress` event carries `eventId` from `thread_messages.id`; pass the last seen id back as `resumeFrom` to replay without gaps:

```typescript
for await (const event of conversation.stream({ resumeFrom: lastEventId })) {
  if (event.eventId) lastEventId = event.eventId;
}
```

Use `conversation.streamEvents()` when the UI needs more than plain messages. It streams normalized conversation events with stable cursors for messages, progress, status changes, tool calls, tool results, file changes, attachments, final results, and app-defined events:

```typescript
await conversation.emitEvent({
  kind: 'artifact.update',
  text: 'Preview updated',
  payload: { artifact_id: 'artifact_1', version: 2 },
});

for await (const event of conversation.streamEvents({ resumeFrom: lastCursor })) {
  if (event.kind === 'snapshot') {
    for (const entry of event.events) lastCursor = entry.cursor;
    continue;
  }
  if ('event' in event) lastCursor = event.event.cursor;
}
```

`conversation.events({ kind, jobId, workflowStep, after })` returns the same ordered event shape as JSON. The underlying job log stream stays available for debugging.

### SSE Authentication

The middleware supports `?token=` query parameter for Server-Sent Events:

```
GET /api/events?token=eyJ...
```

## API Reference: Chat SDKs

| Package | Export | Description |
|---------|--------|-------------|
| `@eve-horizon/chat` | `createConversationClient()` | Browser/Node client for ensure, get, send, messages, events, and streams |
| `@eve-horizon/chat/server` | `EveConversationsClient` | Server-side helper for backend-proxied turns |
| `@eve-horizon/chat/server` | `forwardTurn()` | Apply enrichment/rejection hooks before forwarding a turn |
| `@eve-horizon/chat-react` | `EveConversationProvider` | React state provider for one app conversation |
| `@eve-horizon/chat-react` | `useEveConversation()` | Hook exposing conversation state, `ensure`, `send`, and `reconnect` |
| `@eve-horizon/chat-react` | `EveConversationPane` | Headless render-prop pane |
| `@eve-horizon/chat-react` | `EveConversationDefaultPane` | Minimal styled conversation pane |

## API Reference: `@eve-horizon/auth`

| Export | Type | Description |
|--------|------|-------------|
| `eveUserAuth(options?)` | Middleware | Verify user token, check org, attach `req.eveUser` |
| `eveAuthGuard()` | Middleware | 401 if `req.eveUser` not set |
| `eveAuthConfig()` | Handler | Serve `{ sso_url, eve_api_url, ... }` from env |
| `eveAuthMiddleware(options?)` | Middleware | Agent/job token verification, attach `req.agent` |
| `verifyEveToken(token, url?)` | Function | JWKS-based local verification (15-min cache) |
| `verifyEveTokenRemote(token, url?)` | Function | HTTP verification via `/auth/token/verify` |

### Types

```typescript
interface EveUser {
  id: string;
  email: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
}

interface EveTokenClaims {
  valid: true;
  type: 'user' | 'job' | 'service_principal';
  user_id: string;
  email?: string;
  org_id?: string | null;
  orgs?: Array<{ id: string; role: string }>;
  project_id?: string;
  job_id?: string;
  permissions?: string[];
  is_admin?: boolean;
}
```

## API Reference: `@eve-horizon/auth-react`

| Export | Type | Description |
|--------|------|-------------|
| `EveAuthProvider` | Component | Context provider, session bootstrap |
| `useEveAuth()` | Hook | `{ user, loading, loginWithSso, loginWithToken, logout }` |
| `EveLoginGate` | Component | Render children when authed, login form when not |
| `EveLoginForm` | Component | SSO + token paste login UI |
| `createEveClient(baseUrl?)` | Function | Fetch wrapper with Bearer injection |
| `getStoredToken()` | Function | Read cached token from sessionStorage |
| `storeToken(token)` | Function | Write token to sessionStorage |
| `clearToken()` | Function | Remove cached token |

## Deep-Dive Docs

- [Eve Auth SDK](./eve-auth-sdk.md) -- System-level reference, architecture, migration guide
- [App SSO Integration](./app-sso-integration.md) -- Quick-start guide
- [Auth & Governance](./auth.md) -- Platform auth internals
- [Agent App API Access](./agent-app-api-access.md) -- Agent job token verification

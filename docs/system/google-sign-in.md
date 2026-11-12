# Google sign-in for existing app members

Google sign-in uses the existing GoTrue authentication server and Eve SSO session.
It is disabled by default, and must be enabled by both the deployment operator and
the application project. Applications continue using their current Eve token,
app-access checks and project permissions.

## Admission policy

This flow signs in **existing Eve users who already have access to the app**.
It does not create Eve users, memberships or invitations, accept pending invites,
or enrol an email domain. Complete membership provisioning through the existing
administrative flow before Google sign-in. The project's `self_signup` and
`domain_signup` settings continue to govern their existing email flows; they do
not expand Google admission.

The API validates the GoTrue session through `/user`, requires a confirmed primary
email and a Google identity with a verified matching email, then resolves the
existing Supabase-to-Eve identity link. Only an unlinked identity can fall back to
the verified email of an existing Eve user. Current app access must pass before
the link is created and a token is minted. Existing user IDs and authorship are
preserved. A company email suffix is not membership.

GoTrue may create its own authentication record on the first Google login. This
does not create an Eve user or grant app access. If the deployment disables all
GoTrue signup, arrange the existing user's GoTrue account through its supported
administrative process first; otherwise the provider may reject that first login.
This addition does not change the legacy `/auth/exchange`, session refresh or
signup routes. Their existing invitation policies continue to apply; the
existing-member restriction above describes admission through the new route.

## Project configuration

Add the provider to the app's existing manifest auth block and sync the manifest:

```yaml
x-eve:
  auth:
    login_method: password_or_magic_link
    oauth_providers: [google]
    self_signup: false
    allowed_redirect_origins:
      - https://workspace.example.com
```

`oauth_providers` defaults to `[]`. Only `google` is currently supported.
`login_method` continues selecting the email controls; Google is an additional
explicit option. Projectless login pages do not show the Google button.

## Deployment configuration

Make changes in the **private deployment instance repository** that owns the
environment. Do not put Google credentials or instance secrets in this public
source repository. Source releases publish images; the owning instance separately
rolls out the API and SSO images.

Register a Google OAuth **Web application** client. Its authorised redirect URI
is the **public GoTrue callback**, for example:

```text
https://auth.example.com/callback
```

This is different from the SSO callback. Google returns to GoTrue; GoTrue returns
to `https://sso.example.com/auth/google/callback` with a short-lived code. Keep the
Google client's allowed audience/consent policy appropriate to the organisation.
Google identity scopes do not authorise Drive access; connector consent remains
separate. See [Google's server-side OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server).

Configure these values on GoTrue (the base runtime uses v2.185.0):

| Variable | Value |
| --- | --- |
| `GOTRUE_EXTERNAL_GOOGLE_ENABLED` | `true` |
| `GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID` | The registered Google client ID. |
| `GOTRUE_EXTERNAL_GOOGLE_SECRET` | Secret reference for that client's secret. |
| `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI` | Exact public GoTrue callback registered with Google. |
| `API_EXTERNAL_URL` | Public GoTrue base URL. |
| `GOTRUE_SITE_URL` | Public SSO origin. |

GoTrue's existing redirect policy must permit the SSO callback, including its
state query parameter. When `GOTRUE_SITE_URL` uses the SSO hostname, the pinned
GoTrue version accepts same-host return paths. If an instance uses a different
site URL, explicitly allow the broker callback through its URI allowlist and
verify the round trip. Preserve any other required return destinations.

Configure these values on SSO:

| Variable | Value |
| --- | --- |
| `EVE_SSO_GOOGLE_ENABLED` | `true` |
| `EVE_SSO_URL` | Exact public SSO origin, e.g. `https://sso.example.com`. |
| `SUPABASE_AUTH_EXTERNAL_URL` | Public GoTrue base, e.g. `https://auth.example.com`. |
| `SUPABASE_AUTH_URL` | Existing internal GoTrue URL for server-side calls. |
| `EVE_SSO_OAUTH_STATE_KEY` | Secret containing 32 random bytes encoded as base64url. |
| `EVE_SSO_SECURE_COOKIES` | `true` for HTTPS deployments. |
| `EVE_DEFAULT_DOMAIN` | Existing parent domain used for SSO session cookies. |

Keep the state key stable across SSO replicas and restarts. Generate it with a
cryptographically secure random generator and write it directly to the instance's
secret manager; do not commit or log it. The state cookie has a five-minute
lifetime, so rotating this key invalidates outstanding login attempts.

Enabled SSO requires valid configuration at startup. URLs cannot contain embedded
credentials, query strings or fragments. HTTPS is required for hosted use; local
HTTP is limited to the supported development hosts with secure cookies disabled.
The API also needs its existing internal `SUPABASE_AUTH_URL` and Eve signing keys.

For example, an instance's SSO Deployment patch can reference its secret:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eve-sso
  namespace: eve
spec:
  template:
    spec:
      containers:
        - name: sso
          env:
            - name: EVE_SSO_GOOGLE_ENABLED
              value: "true"
            - name: EVE_SSO_URL
              value: https://sso.example.com
            - name: SUPABASE_AUTH_EXTERNAL_URL
              value: https://auth.example.com
            - name: EVE_SSO_OAUTH_STATE_KEY
              valueFrom:
                secretKeyRef:
                  name: eve-google-sign-in
                  key: sso-state-key
```

Set the GoTrue Google secret through a secret reference in the GoTrue Deployment
as well. This example is documentation, not a default-enabled base deployment or
a complete instance configuration.

## Request flow

1. SSO renders **Continue with Google** when both operator and project opt in.
2. `/auth/google/start` checks current project policy, return destination and
   GoTrue provider availability. It creates an encrypted, host-only, HttpOnly,
   SameSite=Lax transaction cookie and a PKCE challenge. The cookie is Secure
   with the `__Host-` prefix on HTTPS.
3. The browser visits GoTrue `/authorize`, then Google. GoTrue owns the provider
   state and token verification. The broker's separate state lives in the fixed
   SSO callback URL; it is never supplied as GoTrue's top-level provider state.
4. `/auth/google/callback` validates the transaction cookie, state and expiry,
   rechecks project policy, and exchanges the one-time code with its PKCE verifier
   over the server connection. Tokens never enter the new browser callback URL.
5. SSO calls `POST /auth/oauth/exchange` with the GoTrue Bearer token and
   `{ "project_id": "<project_id>", "provider": "google" }`. The API performs
   the existing-member admission checks above and returns the normal Eve exchange
   response. SSO sets the existing session cookies and returns to the validated app.
6. Existing `/session` refresh and `/logout` continue to apply. Apps must still
   enforce current Eve access and their own project-level permissions.

One outstanding Google attempt is supported per browser cookie jar. Starting a
second attempt replaces the first; an old tab must start again. Failure or
cancellation creates no new SSO session and does not clear an unrelated existing
session. Restart sign-in after expired state or a consumed code.

## Validation and rollback

Before enabling a hosted app, verify an existing member reaches the app with the
same Eve user ID; a nonmember is denied; membership removal takes effect; refresh
and sign-out work; and the exact custom/local application return works in the
browsers the team uses. Local tests with synthetic provider responses do not
establish Google consent, hosted configuration or cross-site cookie compatibility.

Google login does not send magic-link email. Invitations, password recovery and
email sign-in still need their existing mail configuration.

To stop new Google logins, disable it on SSO or remove `google` from the project
provider list. This does not delete identities, membership or authored records,
and it does not revoke existing sessions. Use the existing membership/session
controls when revocation is required. Remove the optional manifest field and sync
the manifest with the new API before rolling the API back to a version whose
strict schema does not recognise it. The new API omits an empty provider list
from stored project configuration so disabled projects remain readable by the
preceding schema.

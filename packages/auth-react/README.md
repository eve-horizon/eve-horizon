# @eve-horizon/auth-react

React SDK for Eve SSO. Wrap your app with a provider, gate protected content, and get login UI for free.

## Install

```bash
npm install @eve-horizon/auth-react
```

## Quick Start

```tsx
import { EveAuthProvider, EveLoginGate } from '@eve-horizon/auth-react';

function App() {
  return (
    <EveAuthProvider apiUrl="/api">
      <EveLoginGate>
        <ProtectedApp />
      </EveLoginGate>
    </EveAuthProvider>
  );
}
```

Use the `useEveAuth` hook for user state and actions:

```tsx
import { useEveAuth } from '@eve-horizon/auth-react';

function Profile() {
  const { user, logout } = useEveAuth();
  return <div>{user?.email} <button onClick={logout}>Logout</button></div>;
}
```

For apps that use Eve app-org access policies, `useEveAppAccess()` returns the
allowed orgs for the current user and an `inviteMember()` helper for in-app
admin pages:

```tsx
import { useEveAppAccess } from '@eve-horizon/auth-react';

function AdminInvite() {
  const { adminOrgs, inviteMember } = useEveAppAccess();
  // POST /auth/app-invites via Eve API after the user submits an email.
}
```

## Docs

Full reference: [Eve Auth SDK Documentation](https://github.com/eve-horizon/eve-horizon/blob/main/docs/system/eve-auth-sdk.md)

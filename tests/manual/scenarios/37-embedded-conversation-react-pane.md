# 37 - Embedded Conversation React Pane

Validates `@eve-horizon/chat-react` in a browser app.

## Steps

1. Build SDK packages:
   ```bash
   pnpm --filter @eve-horizon/chat build
   pnpm --filter @eve-horizon/chat-react build
   ```
2. Add a page in the fullstack example that wraps `EveConversationDefaultPane` in `EveConversationProvider`.
3. Deploy the example app to local k3d.
4. Open the app, sign in through Eve SSO, send three turns, and verify messages stream into the pane.
5. Reload mid-stream and verify the thread history returns in the snapshot.
6. Sign in as a user without access to the project and verify the conversation endpoints return `403`.

# 36 - Embedded Conversation Facade

Validates `/projects/:project_id/conversations` against local k3d.

## Steps

1. Confirm k3d and auth:
   ```bash
   ./bin/eh status
   export EVE_API_URL=http://api.eve.lvh.me
   eve org ensure manual-test-org --slug manual-test-org --json
   TOKEN=$(eve auth token --raw)
   ```
2. Create or reuse a project with a routable app agent (`gateway.policy: routable`, `gateway.clients: [app]`) and sync agents.
3. Ensure a conversation:
   ```bash
   curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -X POST "$EVE_API_URL/projects/$PROJECT_ID/conversations" \
     -d '{"app_key":"manual:conv-1","app_id":"manual-app","metadata":{"product_route":"/x"}}'
   ```
   Expect `thread_id`, `key` prefixed with `app:manual-app:sha256:`, and metadata containing `app_key`.
4. Send an explicit agent turn:
   ```bash
   curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -X POST "$EVE_API_URL/projects/$PROJECT_ID/conversations/manual%3Aconv-1/turns" \
     -d '{"text":"hello","target":{"kind":"agent","agent_slug":"od-designer"}}'
   ```
   Expect `thread_id`, `job_ids[]`, `target=agent:<id>`, `dispatch_status=queued`.
5. Open SSE:
   ```bash
   curl -N -H "Authorization: Bearer $TOKEN" "$EVE_API_URL/projects/$PROJECT_ID/conversations/manual%3Aconv-1/stream"
   ```
   Expect a `snapshot` event and later `message`/`progress` events with `id:` fields.
6. Reopen the SSE stream. Expect the snapshot to include prior messages.
7. Request messages and metadata:
   ```bash
   curl -fsS -H "Authorization: Bearer $TOKEN" "$EVE_API_URL/projects/$PROJECT_ID/conversations/manual%3Aconv-1/messages"
   curl -fsS -H "Authorization: Bearer $TOKEN" "$EVE_API_URL/projects/$PROJECT_ID/conversations/manual%3Aconv-1"
   ```
8. SDK smoke:
   ```bash
   pnpm --filter @eve-horizon/chat build
   PROJECT_ID=$PROJECT_ID TOKEN=$TOKEN APP_KEY=manual:conv-1 APP_ID=manual-app \
     pnpm exec tsx tests/manual/scripts/embedded-conversation-sdk.ts
   ```
9. Resume from the last SSE id:
   ```bash
   curl -N -H "Authorization: Bearer $TOKEN" \
     -H "Last-Event-ID: $LAST_EVENT_ID" \
     "$EVE_API_URL/projects/$PROJECT_ID/conversations/manual%3Aconv-1/stream"
   ```
   Expect only messages strictly after `$LAST_EVENT_ID`.

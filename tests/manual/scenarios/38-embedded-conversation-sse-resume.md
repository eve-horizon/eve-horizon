# 38 - Embedded Conversation SSE Resume

Validates true `Last-Event-ID` replay once resumable thread streams are enabled.

## Steps

1. Open an SDK stream with `conv.stream()`.
2. Run a long-running chat-triggered agent job that emits progress.
3. Abort the stream after receiving an event id.
4. Reconnect with `resumeFrom: lastEventId`.
5. Verify no message is duplicated and no message is missed.
6. Restart the API pod:
   ```bash
   ./bin/eh kubectl -n eve rollout restart deploy/eve-api
   ./bin/eh kubectl -n eve rollout status deploy/eve-api
   ```
7. Reconnect again with the last event id and verify the same no-gap/no-duplicate property.

Expected wire behavior:

- `message` and `progress` events include `id: <thread_messages.id>`.
- `progress` event payloads include `kind: "progress"`.
- `Last-Event-ID` replays messages strictly after the supplied id, including after API restart.

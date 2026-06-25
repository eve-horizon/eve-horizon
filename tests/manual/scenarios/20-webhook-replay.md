# Scenario 20: Webhook Replay & Deduplication

**Time:** ~2 minutes
**Parallel Safe:** Yes
**LLM Required:** No

End-to-end validation of webhook replay, dry-run preview, deduplication, and replay status polling.

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| Webhook subscription creation | Setup |
| Test event delivery | Step 1 |
| Replay dry-run (preview) | Step 2 |
| Replay execution | Step 3 |
| Replay status polling | Step 4 |
| Deduplication on re-replay | Step 5 |
| Delivery log inspection | Step 6 |

## Prerequisites

- Smoke tests pass (scenario 01)
- Events exist in the org (run scenario 04 first, or this scenario creates test events)
- `EVE_API_URL` set (see main README)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
```

### Create a Webhook Subscription

Create a subscription that listens for all events. Use a test URL (delivery will fail but that's fine — we're testing replay mechanics, not delivery success).

```bash
eve webhooks create --org $ORG_ID \
  --url "https://httpbin.org/post" \
  --events "system.*,webhook.test" \
  --secret "test-secret-scenario-20" \
  --json
```

**Expected:**
- Webhook created with an ID (e.g., `wh_xxx`)
- `enabled: true`

Save the webhook ID:
```bash
export WH_ID=<id_from_output>
```

## Steps

### 1. Send Test Events

Fire a few test events to populate the delivery queue.

```bash
eve webhooks test $WH_ID --org $ORG_ID --json
eve webhooks test $WH_ID --org $ORG_ID --json
eve webhooks test $WH_ID --org $ORG_ID --json
```

**Expected:**
- Each call returns a delivery acknowledgement
- Three `webhook.test` events now exist

Wait a moment for deliveries to be attempted:
```bash
sleep 3
```

### 2. Replay Dry-Run

Preview what a replay would do without actually creating deliveries.

```bash
eve webhooks replay $WH_ID --org $ORG_ID --dry-run --json
```

**Expected:**
- Returns `event_count` (number of events that would be replayed)
- Returns `earliest` and `latest` timestamps
- Returns `would_deduplicate` count (events already delivered)
- No actual deliveries are created

### 3. Execute Replay

Run a real replay to re-deliver events.

```bash
eve webhooks replay $WH_ID --org $ORG_ID --max-events 100 --json
```

**Expected:**
- Returns `replay_id`
- `status` is `"completed"` (or `"queued"` / `"running"` if async)
- `requested` shows how many events matched
- `deduplicated` shows events already delivered (from step 1)

Save the replay ID:
```bash
export REPLAY_ID=<replay_id_from_output>
```

### 4. Check Replay Status

Poll the replay status endpoint.

```bash
eve webhooks replay-status $WH_ID $REPLAY_ID --org $ORG_ID --json
```

**Expected:**
- `replay_id` matches the one from step 3
- `status` is `"completed"`
- `requested`, `processed`, `replayed`, `deduplicated` counts are present
- `replayed + deduplicated` should equal `processed`

### 5. Verify Deduplication on Re-Replay

Run the same replay again — all events should now be deduplicated.

```bash
eve webhooks replay $WH_ID --org $ORG_ID --max-events 100 --json
```

**Expected:**
- New `replay_id` (different from step 3)
- `deduplicated` count should be >= the `replayed` count from step 3
- `replayed` should be 0 or very low (only new events since step 3)

### 6. Inspect Delivery Log

List delivery attempts for the webhook to confirm events were recorded.

```bash
eve webhooks deliveries $WH_ID --org $ORG_ID --json
```

**Expected:**
- Response has `data` array with multiple delivery entries
- Each delivery has an `event_id`, `status`, and `created_at`
- Deliveries from both the initial test events and the replay are present

## Success Criteria

- [ ] Webhook subscription created and enabled
- [ ] Test events generate delivery attempts
- [ ] Dry-run returns accurate preview (`event_count`, `would_deduplicate`) without side effects
- [ ] Replay creates a replay record with a trackable `replay_id`
- [ ] Replay status endpoint shows progress and final counts
- [ ] Deduplication prevents double-delivery on re-replay
- [ ] Delivery log shows entries from both initial delivery and replay

## CLI Commands Reference

```bash
eve webhooks create --org <org> --url <url> --events <patterns> --secret <secret> [--json]
eve webhooks list --org <org> [--json]
eve webhooks test <wh_id> --org <org> [--json]
eve webhooks replay <wh_id> --org <org> [--dry-run] [--from-event <id>] [--to <iso>] [--max-events <n>] [--json]
eve webhooks replay-status <wh_id> <replay_id> --org <org> [--json]
eve webhooks deliveries <wh_id> --org <org> [--limit <n>] [--json]
eve webhooks delete <wh_id> --org <org>
```

## Debugging

### Replay returns 0 events

The default replay window is the last 24 hours. Ensure test events were created recently:
```bash
eve webhooks test $WH_ID --org $ORG_ID --json
eve webhooks replay $WH_ID --org $ORG_ID --dry-run --json
```

### Replay returns 409 (too many concurrent replays)

Max 3 concurrent replays per subscription. Wait for existing replays to complete:
```bash
eve webhooks replay-status $WH_ID <existing_replay_id> --org $ORG_ID --json
```

### Webhook not found

Verify the webhook ID and org:
```bash
eve webhooks list --org $ORG_ID --json
```

### All events show as deduplicated

This is correct behavior on re-replay. The unique constraint `(subscription_id, event_id)` prevents duplicate deliveries. Send new test events to see fresh replays:
```bash
eve webhooks test $WH_ID --org $ORG_ID --json
eve webhooks replay $WH_ID --org $ORG_ID --json
```

## Cleanup

```bash
eve webhooks delete $WH_ID --org $ORG_ID
```

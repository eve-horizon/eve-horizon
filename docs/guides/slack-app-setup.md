# Slack App Setup Guide

> Purpose: Step-by-step guide for connecting a Slack workspace to Eve Horizon.

This guide walks you through creating a Slack App, configuring it for Eve Horizon, and connecting it to your org so that team members can interact with agents directly from Slack channels.

---

## Prerequisites

- An Eve Horizon org with at least one project and agent configured
- Admin access to the target Slack workspace
- Access to the Eve CLI (`eve`) authenticated against your org
- Your Eve gateway host URL (e.g., `https://gateway.your-domain.com`)

---

## 1. Create the Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** and select **From scratch**
3. Set the app name to `Eve` (or an org-specific name like `Eve - Acme Corp`)
4. Select the target Slack workspace
5. Click **Create App**

---

## 2. Configure Bot Token Scopes

Navigate to **OAuth & Permissions** in the left sidebar, then scroll to **Bot Token Scopes** and add each of the following:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Receive `@Eve` mentions in channels |
| `chat:write` | Send replies and threaded messages |
| `chat:write.public` | Send messages in public channels where the app has not been invited |
| `channels:history` | Read messages for listener dispatch |
| `channels:read` | Resolve channel info |
| `groups:history` | Read messages in private channels |
| `groups:read` | Resolve private channel info for listeners |
| `im:history` | Read direct messages |
| `im:write` | Send DM notifications to users (approval notices, link confirmations) |
| `users:read` | Look up Slack user profiles for identity auto-match |
| `users:read.email` | Access Slack user email for auto-binding to Eve accounts |
| `reactions:read` | Receive emoji reaction events for agent feedback (future) |
| `files:read` | Required for file attachment ingest (future) |

---

## 3. Enable Event Subscriptions

1. Navigate to **Event Subscriptions** in the left sidebar
2. Toggle **Enable Events** to On
3. Set the **Request URL** to:
   ```
   https://<gateway-host>/gateway/providers/slack/webhook
   ```
   Replace `<gateway-host>` with your Eve gateway hostname. Slack will send a challenge request to verify the URL -- it should succeed immediately if the gateway is running.
4. Under **Subscribe to bot events**, add:
   - `app_mention` -- triggers when a user mentions `@Eve` in a channel
   - `message.channels` -- triggers on messages in public channels (used for listener dispatch)
   - `message.groups` -- triggers on messages in private channels
   - `message.im` -- triggers on direct messages to the bot
5. Click **Save Changes**

---

## 4. Enable Interactive Components

1. Navigate to **Interactivity & Shortcuts** in the left sidebar
2. Toggle **Interactivity** to On
3. Set the **Request URL** to:
   ```
   https://<gateway-host>/gateway/providers/slack/interactive
   ```
4. Click **Save Changes**

This enables interactive message components such as membership approval buttons.

---

## 5. Configure OAuth Redirect URL

Before installing to any workspace, configure the OAuth redirect URL in your Slack app:

1. Navigate to **OAuth & Permissions** in the left sidebar
2. Under **Redirect URLs**, add:
   ```
   https://<api-host>/integrations/slack/oauth/callback
   ```
   Replace `<api-host>` with your Eve API hostname (e.g., `api.eve.example.com`).
3. Click **Save URLs**

This redirect URL is where Slack sends the user after they approve the app installation. The Eve API exchanges the OAuth code for a bot token automatically.

---

## 6. Gather Credentials

You need one value from the Slack console:

| Credential | Where to find it |
|---|---|
| **Signing Secret** | **Basic Information** page, under **App Credentials** |

You also need the **Client ID** and **Client Secret** from the same **Basic Information** page if you plan to use the OAuth install flow (recommended).

> **Note**: You no longer need to manually copy the Bot User OAuth Token. The OAuth install flow handles token exchange automatically.

---

## 7. Configure the Gateway Signing Secret

The signing secret is used by the Eve gateway to verify that incoming webhooks are genuinely from Slack. Set it as an environment variable on the gateway service:

```
EVE_SLACK_SIGNING_SECRET=<your-signing-secret>
```

How you set this depends on your deployment:
- **K8s / Helm**: Add to your secrets manifest or use `kubectl create secret`
- **Docker Compose**: Add to the gateway service environment
- **Local dev**: Add to your `.env` or system secrets file

---

## 8. Install via Shareable Link (Recommended)

The easiest way to install the Slack app is to generate a shareable install link. This uses signed tokens so the recipient does not need Eve credentials -- they only need admin access to the target Slack workspace.

### Generate the install link

```bash
eve integrations slack install-url --org <org_id>
```

Options:
- `--ttl <duration>` -- Token lifetime (default `24h`, max `30d`). Accepts `24h`, `7d`, `3600`, etc.

This outputs a URL like:
```
https://<api-host>/integrations/slack/install?token=eve-slack-install-...
```

### Share the link

Send the URL to whoever has admin access to the Slack workspace. When they open it:
1. They are redirected to the Slack OAuth consent screen
2. They review permissions and click **Allow**
3. Slack redirects back to Eve, which exchanges the OAuth code for a bot token
4. The integration is created automatically -- no manual token copying needed

### Gateway hot-loading

After installation, the gateway automatically detects the new integration within **30 seconds** (no restart required). The gateway polls for new integrations periodically and initializes them on the fly.

### Verify

```bash
eve integrations list --org <org_id>
eve integrations test <integration_id> --org <org_id>
```

### Alternative: Manual connect

If you cannot use the OAuth flow (e.g., air-gapped environments), you can still connect manually:

```bash
eve integrations slack connect \
  --org <org_id> \
  --team-id <T-ID> \
  --token xoxb-...
```

- `--org` is your Eve org ID (e.g., `org_acmecorp`)
- `--team-id` is the Slack workspace ID (e.g., `T04ABCDEF12`)
- `--token` is the Bot User OAuth Token from the **OAuth & Permissions** page

---

## 9. Configure Agent Routing

### Set a default agent

When a user mentions `@Eve` without specifying an agent slug, Eve routes to the org's default agent. Set it with:

```bash
eve org update <org_id> --default-agent <agent-slug>
```

### Make agents routable from Slack

In your project's `agents.yaml`, ensure the agent has a gateway policy that allows Slack routing:

```yaml
agents:
  - slug: my-agent
    name: My Agent
    gateway:
      policy: routable
      clients: [slack]
```

The `policy` field controls visibility:
- `routable` -- the agent can be invoked and appears in the agent directory
- `discoverable` -- the agent appears in the directory but cannot be invoked
- `none` -- the agent is hidden from gateway clients

After updating `agents.yaml`, sync agents:

```bash
eve agents sync --project <project_id>
```

---

## 10. Test in Slack

Open a channel in the connected workspace and try:

```
@Eve hello
```

This routes to the default agent. To target a specific agent:

```
@Eve my-agent summarize the latest PR
```

To see all available agents:

```
@Eve agents list
```

To have an agent listen to all messages in a channel (no `@Eve` mention required):

```
@Eve agents listen my-agent
```

To stop listening:

```
@Eve agents unlisten my-agent
```

To see what agents are listening in the current channel or thread:

```
@Eve agents listening
```

---

## Troubleshooting

### Slack says "URL verification failed" when enabling Event Subscriptions

- Confirm the gateway is running and reachable from the internet
- Verify the Request URL is exactly `https://<gateway-host>/gateway/providers/slack/webhook`
- Check that no firewall or WAF is blocking POST requests to the gateway
- Look at gateway logs for incoming requests -- if nothing appears, the request is not reaching the service

### `@Eve` mention in Slack produces no response

1. Check that the integration exists and is active:
   ```bash
   eve integrations list --org <org_id>
   ```
2. Test the integration:
   ```bash
   eve integrations test <integration_id> --org <org_id>
   ```
3. Verify a default agent is set:
   ```bash
   eve org show <org_id> --json
   ```
   Look for `default_agent_slug` in the output.
4. Check that the agent has `gateway.policy: routable` in `agents.yaml`
5. Check gateway logs for errors related to signature verification or routing

### "Unknown agent slug" reply in Slack

The first word after `@Eve` is treated as an agent slug. If it does not match any synced agent and no default agent is configured, you will see this error.

- List available agent slugs: `@Eve agents list`
- Set a default agent: `eve org update <org_id> --default-agent <slug>`

### "Slack signing secret not configured" in gateway logs

The `EVE_SLACK_SIGNING_SECRET` environment variable is missing from the gateway service. Add the signing secret from the Slack app's **Basic Information** page.

### "No default agent configured" reply in Slack

No default agent slug is set on the org and the command did not match a specific agent slug.

```bash
eve org update <org_id> --default-agent <agent-slug>
```

### Bot replies in a channel but not in DMs

Ensure the `im:history` scope is added and the `message.im` event subscription is enabled.

### Messages in private channels are ignored

Ensure the `groups:history` and `groups:read` scopes are added and the `message.groups` event subscription is enabled. The bot must also be invited to the private channel.

### Integration test fails

- Verify the bot token (`xoxb-...`) has not been revoked or rotated
- If using the OAuth install flow, re-generate an install link and re-install the app:
  ```bash
  eve integrations slack install-url --org <org_id>
  ```
- If using the manual flow, re-run the connect command with the current token:
  ```bash
  eve integrations slack connect \
    --org <org_id> \
    --team-id <T-ID> \
    --token xoxb-<new-token>
  ```

### Install link says "Invalid, expired, or already-used install token"

Install tokens are single-use and expire after the configured TTL (default 24h). Generate a fresh one:
```bash
eve integrations slack install-url --org <org_id>
```

import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type IntegrationResponse = {
  id: string;
  org_id: string;
  provider: string;
  account_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type IntegrationListResponse = {
  integrations: IntegrationResponse[];
};

type OAuthAppConfigResponse = {
  id: string;
  org_id: string;
  provider: string;
  client_id: string;
  label: string | null;
  status: string;
  has_signing_secret?: boolean;
  created_at: string;
  updated_at: string;
};

type ProviderSetupInfoResponse = {
  provider: string;
  callback_url: string | null;
  webhook_url: string | null;
  required_scopes: string[];
  setup_instructions: string;
};

/** Normalize provider names: google-drive -> google_drive */
function normalizeProvider(name: string): string {
  return name.replace(/-/g, '_');
}

export async function handleIntegrations(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;

  switch (subcommand) {
    case 'list': {
      if (!orgId) {
        throw new Error('Usage: eve integrations list --org <org_id>');
      }
      const response = await requestJson<IntegrationListResponse>(context, `/orgs/${orgId}/integrations`);
      outputJson(response, json);
      return;
    }

    // ── OAuth app config commands ──────────────────────────────────────────

    case 'configure': {
      // eve integrations configure <provider> --client-id "..." --client-secret "..." [--signing-secret "..."] [--app-id "..."] [--label "..."]
      const provider = normalizeProvider(positionals[0] ?? '');
      if (!provider) {
        throw new Error(
          'Usage: eve integrations configure <provider> --client-id "..." --client-secret "..."\n\n' +
          'Providers: google-drive, slack\n\n' +
          'Options:\n' +
          '  --client-id       OAuth client ID (required)\n' +
          '  --client-secret   OAuth client secret (required)\n' +
          '  --signing-secret  Slack signing secret (Slack only)\n' +
          '  --app-id          Slack app ID (Slack only)\n' +
          '  --label           Human-readable label',
        );
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const clientId = getStringFlag(flags, ['client-id', 'client_id']);
      const clientSecret = getStringFlag(flags, ['client-secret', 'client_secret']);
      if (!clientId || !clientSecret) {
        throw new Error('Missing --client-id or --client-secret');
      }

      const label = getStringFlag(flags, ['label']);
      const signingSecret = getStringFlag(flags, ['signing-secret', 'signing_secret']);
      const appId = getStringFlag(flags, ['app-id', 'app_id']);

      const config: Record<string, unknown> = {};
      if (signingSecret) config.signing_secret = signingSecret;
      if (appId) config.app_id = appId;

      const body: Record<string, unknown> = {
        client_id: clientId,
        client_secret: clientSecret,
      };
      if (Object.keys(config).length > 0) body.config = config;
      if (label) body.label = label;

      const response = await requestJson<OAuthAppConfigResponse>(
        context,
        `/orgs/${orgId}/integrations/providers/${provider}/config`,
        { method: 'POST', body },
      );

      if (json) {
        outputJson(response, true);
      } else {
        console.log(`✓ OAuth app configured for ${provider}`);
        console.log(`  Config ID:  ${response.id}`);
        console.log(`  Client ID:  ${response.client_id}`);
        if (response.label) console.log(`  Label:      ${response.label}`);
        if (response.has_signing_secret) console.log(`  Signing:    ✓ (signing secret set)`);
        console.log('');
        console.log(`Next step: eve integrations connect ${positionals[0]}`);
      }
      return;
    }

    case 'config': {
      // eve integrations config <provider>
      const provider = normalizeProvider(positionals[0] ?? '');
      if (!provider) {
        throw new Error('Usage: eve integrations config <provider>');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const response = await requestJson<OAuthAppConfigResponse>(
        context,
        `/orgs/${orgId}/integrations/providers/${provider}/config`,
      );

      if (json) {
        outputJson(response, true);
      } else {
        console.log(`OAuth app config: ${provider}`);
        console.log('');
        console.log(`  Config ID:  ${response.id}`);
        console.log(`  Client ID:  ${response.client_id}`);
        console.log(`  Status:     ${response.status}`);
        if (response.label) console.log(`  Label:      ${response.label}`);
        if (response.has_signing_secret) console.log(`  Signing:    ✓ (signing secret set)`);
        console.log(`  Created:    ${response.created_at}`);
        console.log(`  Updated:    ${response.updated_at}`);
      }
      return;
    }

    case 'unconfigure': {
      // eve integrations unconfigure <provider>
      const provider = normalizeProvider(positionals[0] ?? '');
      if (!provider) {
        throw new Error('Usage: eve integrations unconfigure <provider>');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      await requestJson(
        context,
        `/orgs/${orgId}/integrations/providers/${provider}/config`,
        { method: 'DELETE' },
      );

      outputJson({ provider, removed: true }, json, `✓ OAuth app config removed for ${provider}`);
      return;
    }

    case 'setup-info': {
      // eve integrations setup-info <provider>
      const provider = normalizeProvider(positionals[0] ?? '');
      if (!provider) {
        throw new Error('Usage: eve integrations setup-info <provider>');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const response = await requestJson<ProviderSetupInfoResponse>(
        context,
        `/orgs/${orgId}/integrations/providers/${provider}/setup-info`,
      );

      if (json) {
        outputJson(response, true);
      } else {
        console.log(`Setup info for ${provider}`);
        console.log('');
        if (response.callback_url) console.log(`  Callback URL:  ${response.callback_url}`);
        if (response.webhook_url) console.log(`  Webhook URL:   ${response.webhook_url}`);
        console.log(`  Scopes:        ${response.required_scopes.join(', ')}`);
        console.log('');
        console.log('Instructions:');
        console.log(response.setup_instructions);
      }
      return;
    }

    case 'connect': {
      // eve integrations connect <provider> — shorthand for initiating OAuth
      const provider = positionals[0];
      if (!provider) {
        throw new Error('Usage: eve integrations connect <provider>\n\nProviders: google-drive, slack');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const normalizedProvider = normalizeProvider(provider);
      let authorizePath: string;
      switch (normalizedProvider) {
        case 'google_drive':
          authorizePath = `/orgs/${orgId}/integrations/google-drive/authorize`;
          break;
        case 'slack':
          authorizePath = `/orgs/${orgId}/integrations/slack/authorize`;
          break;
        default:
          throw new Error(`Unknown provider: ${provider}. Supported: google-drive, slack`);
      }

      const authorizeUrl = `${context.apiUrl}${authorizePath}`;
      console.log(`Open this URL in your browser to connect ${provider}:\n`);
      console.log(`  ${authorizeUrl}\n`);
      return;
    }

    // ── Existing commands ──────────────────────────────────────────────────

    case 'slack': {
      const action = positionals[0];
      if (action === 'install-url') {
        if (!orgId) {
          throw new Error('Missing org id. Provide --org or set a profile default.');
        }
        const ttlFlag = getStringFlag(flags, ['ttl']);
        const ttlSeconds = ttlFlag ? parseTtl(ttlFlag) : undefined;
        const body: Record<string, unknown> = {};
        if (ttlSeconds !== undefined) body.ttl_seconds = ttlSeconds;

        const response = await requestJson<{ token: string; expires_at: string }>(
          context,
          `/orgs/${orgId}/integrations/slack/install-token`,
          { method: 'POST', body },
        );
        const url = `${context.apiUrl}/integrations/slack/install?token=${encodeURIComponent(response.token)}`;
        if (json) {
          outputJson({ url, expires_at: response.expires_at }, json);
        } else {
          console.log(`Slack install link (expires ${response.expires_at}):\n\n  ${url}\n\nShare this link with your Slack workspace admin.\nNo Eve login required — they just click and approve.`);
        }
        return;
      }
      if (action !== 'connect') {
        throw new Error('Usage: eve integrations slack <connect|install-url> --org <org_id>');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }
      const teamId = getStringFlag(flags, ['team-id']);
      if (!teamId) {
        throw new Error('Missing --team-id');
      }
      const token = getStringFlag(flags, ['token']);
      const tokensJsonFlag = getStringFlag(flags, ['tokens-json']);
      const status = getStringFlag(flags, ['status']);
      let tokensJson: Record<string, unknown> | undefined;
      if (tokensJsonFlag) {
        try {
          const parsed = JSON.parse(tokensJsonFlag);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            tokensJson = parsed as Record<string, unknown>;
          }
        } catch (error) {
          throw new Error('Invalid --tokens-json (must be JSON object)');
        }
      }
      if (!tokensJson && token) {
        tokensJson = { access_token: token };
      }

      const body: Record<string, unknown> = { team_id: teamId };
      if (tokensJson) body.tokens_json = tokensJson;
      if (status) body.status = status;

      const response = await requestJson<IntegrationResponse>(
        context,
        `/orgs/${orgId}/integrations/slack/connect`,
        { method: 'POST', body },
      );
      outputJson(response, json, `✓ Slack integration connected: ${response.id}`);
      return;
    }
    case 'test': {
      const integrationId = positionals[0];
      if (!integrationId) {
        throw new Error('Usage: eve integrations test <integration_id>');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }
      const response = await requestJson<{ ok: boolean }>(
        context,
        `/orgs/${orgId}/integrations/${integrationId}/test`,
        { method: 'POST' },
      );
      outputJson(response, json, response.ok ? '✓ Integration test ok' : 'Integration test failed');
      return;
    }
    case 'update': {
      const integrationId = positionals[0];
      if (!integrationId) {
        throw new Error('Usage: eve integrations update <integration_id> --setting key=value');
      }
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }
      const settingFlag = getStringFlag(flags, ['setting']);
      if (!settingFlag) {
        throw new Error('Missing --setting flag. Usage: --setting admin_channel_id=C12345');
      }
      const eqIdx = settingFlag.indexOf('=');
      if (eqIdx < 1) {
        throw new Error('Invalid --setting format. Use key=value (e.g., admin_channel_id=C12345)');
      }
      const key = settingFlag.slice(0, eqIdx);
      const value = settingFlag.slice(eqIdx + 1);
      const settings: Record<string, unknown> = { [key]: value };

      const response = await requestJson<IntegrationResponse>(
        context,
        `/orgs/${orgId}/integrations/${integrationId}/settings`,
        { method: 'PATCH', body: { settings } },
      );
      outputJson(response, json, `✓ Integration ${integrationId} settings updated`);
      return;
    }
    default:
      throw new Error(
        'Usage: eve integrations <command>\n\n' +
        'Commands:\n' +
        '  list                  List all integrations\n' +
        '  configure <provider>  Register OAuth app credentials (BYOA)\n' +
        '  config <provider>     View OAuth app config (secrets redacted)\n' +
        '  unconfigure <provider> Remove OAuth app config\n' +
        '  setup-info <provider> Show setup instructions and URLs\n' +
        '  connect <provider>    Initiate OAuth connection\n' +
        '  slack <action>        Slack-specific commands\n' +
        '  test <id>             Test an integration\n' +
        '  update <id>           Update integration settings\n\n' +
        'Providers: google-drive, slack\n\n' +
        'Examples:\n' +
        '  eve integrations setup-info google-drive\n' +
        '  eve integrations configure google-drive --client-id "..." --client-secret "..."\n' +
        '  eve integrations connect google-drive\n' +
        '  eve integrations config google-drive',
      );
  }
}

function parseTtl(value: string): number {
  const match = value.match(/^(\d+)(s|m|h|d)?$/);
  if (!match) throw new Error('Invalid --ttl format. Use e.g. 24h, 7d, 3600');
  const num = parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  const multiplier: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return num * multiplier[unit];
}

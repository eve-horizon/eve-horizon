import type { FlagValue } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

// Types matching the API response shapes (ProviderDefinitionJson from @eve/shared)

type ProviderJson = {
  name: string;
  display_name: string;
  api_compatibility: string;
  base_url: string;
  auth: {
    header: string;
    scheme: string | null;
    env_vars: string[];
    platform_secret_ref?: string;
  };
  harnesses: {
    primary: string;
    all: string[];
    env_map: { apiKey: string; baseUrl: string };
  };
  normalization: { strip_patterns: string[] };
  discovery: { models_path: string; has_pricing: boolean } | null;
};

type ProviderListResponse = {
  providers: ProviderJson[];
};

type DiscoveredModel = {
  id: string;
  provider: string;
  display_name?: string;
  pricing?: { input_per_million_usd: string; output_per_million_usd: string } | null;
};

type DiscoveryResponse = {
  provider: string;
  models: DiscoveredModel[];
  fetched_at: string;
  ttl_seconds: number;
  source: string;
};

export async function handleProviders(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'list':
    case undefined: {
      const response = await requestJson<ProviderListResponse>(context, '/providers');
      if (json) {
        outputJson(response, json);
        return;
      }
      renderProviderList(response.providers);
      return;
    }
    case 'show': {
      const name = positionals[0];
      if (!name) throw new Error('Usage: eve providers show <name>');
      const response = await requestJson<ProviderJson>(context, `/providers/${name}`);
      if (json) {
        outputJson(response, json);
        return;
      }
      renderProviderDetail(response);
      return;
    }
    case 'models': {
      const name = positionals[0];
      if (!name) throw new Error('Usage: eve providers models <name>');
      const response = await requestJson<DiscoveryResponse>(context, `/providers/${name}/models`);
      if (json) {
        outputJson(response, json);
        return;
      }
      renderDiscoveredModels(response);
      return;
    }
    default:
      throw new Error('Usage: eve providers <list|show|models>');
  }
}

function renderProviderList(providers: ProviderJson[]): void {
  if (providers.length === 0) {
    console.log('No providers registered.');
    return;
  }

  const rows = providers.map((p) => ({
    name: p.name,
    display: p.display_name,
    compat: p.api_compatibility,
    discovery: p.discovery ? p.discovery.models_path : 'none',
  }));

  const headers = ['Name', 'Display Name', 'API Compat', 'Discovery'];
  const widths = [
    Math.max(headers[0].length, ...rows.map((r) => r.name.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.display.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.compat.length)),
    Math.max(headers[3].length, ...rows.map((r) => r.discovery.length)),
  ];

  const line = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  console.log(line);
  console.log(formatRow(headers, widths));
  console.log(line);
  for (const row of rows) {
    console.log(formatRow([row.name, row.display, row.compat, row.discovery], widths));
  }
  console.log(line);
  console.log(`\n${providers.length} provider(s)`);
}

function renderProviderDetail(p: ProviderJson): void {
  console.log(`Provider: ${p.name}`);
  console.log(`Display Name: ${p.display_name}`);
  console.log(`API Compatibility: ${p.api_compatibility}`);
  console.log(`Base URL: ${p.base_url}`);
  console.log(`Auth Header: ${p.auth.header}${p.auth.scheme ? ` (${p.auth.scheme})` : ''}`);
  console.log(`Auth Env Vars: ${p.auth.env_vars.join(', ')}`);
  console.log(`Harness: ${p.harnesses.primary} (all: ${p.harnesses.all.join(', ')})`);
  console.log(`Discovery: ${p.discovery ? `${p.discovery.models_path} (pricing: ${p.discovery.has_pricing})` : 'none'}`);
}

function renderDiscoveredModels(response: DiscoveryResponse): void {
  console.log(`Provider: ${response.provider} (source: ${response.source})`);
  console.log('');

  if (response.models.length === 0) {
    console.log('No models discovered.');
    return;
  }

  const rows = response.models.map((m) => ({
    id: m.id,
    name: m.display_name ?? '-',
    input: m.pricing?.input_per_million_usd ? `$${m.pricing.input_per_million_usd}/M` : '-',
    output: m.pricing?.output_per_million_usd ? `$${m.pricing.output_per_million_usd}/M` : '-',
  }));

  const headers = ['Model ID', 'Name', 'Input Price', 'Output Price'];
  const widths = [
    Math.max(headers[0].length, ...rows.map((r) => r.id.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.name.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.input.length)),
    Math.max(headers[3].length, ...rows.map((r) => r.output.length)),
  ];

  const line = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  console.log(line);
  console.log(formatRow(headers, widths));
  console.log(line);
  for (const row of rows) {
    console.log(formatRow([row.id, row.name, row.input, row.output], widths));
  }
  console.log(line);
  console.log(`\n${response.models.length} model(s) discovered`);
}

function formatRow(columns: string[], widths: number[]): string {
  const cells = columns.map((value, idx) => ` ${padRight(value, widths[idx])} `);
  return `|${cells.join('|')}|`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

import type { FlagValue } from '../lib/args';
import { getStringFlag, getBooleanFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, unwrapListResponse } from '../lib/client';
import { outputJson } from '../lib/output';
import { parseResourceUri } from '@eve/shared';

export async function handleResources(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;

  if (!orgId) {
    throw new Error('Missing org id. Provide --org or set a profile default.');
  }

  const uri = getStringFlag(flags, ['uri']) ?? positionals[0];

  switch (subcommand) {
    case 'resolve': {
      if (!uri) {
        throw new Error('Usage: eve resources resolve <uri> [--no-content]');
      }
      const includeContent = !(getBooleanFlag(flags, ['no-content']) ?? false);
      const result = await requestJson(
        context,
        `/orgs/${orgId}/resources/resolve`,
        {
          method: 'POST',
          body: { uris: [uri], include_content: includeContent },
        },
      );
      outputJson(result, json);
      return;
    }

    case 'cat': {
      if (!uri) {
        throw new Error('Usage: eve resources cat <uri>');
      }
      const resultResponse = await requestJson<{ data: { content?: string }[] } | { content?: string }[]>(
        context,
        `/orgs/${orgId}/resources/resolve`,
        {
          method: 'POST',
          body: { uris: [uri], include_content: true },
        },
      );
      const result = unwrapListResponse(resultResponse);
      if (json) {
        outputJson({ data: result }, json);
        return;
      }
      const content = result?.[0]?.content;
      if (content === undefined) {
        throw new Error('No content returned for resource');
      }
      console.log(content);
      return;
    }

    case 'ls': {
      if (!uri) {
        throw new Error('Usage: eve resources ls <uri-prefix>');
      }
      const parsed = parseResourceUri(uri);
      if (parsed?.scheme === 'org_docs') {
        const prefix = parsed.path;
        const result = await requestJson(
          context,
          `/orgs/${orgId}/docs?path=${encodeURIComponent(prefix)}`,
        );
        outputJson(result, json);
        return;
      }

      const jobPrefix = 'job_attachments:/';
      let jobId: string | undefined;
      let namePrefix: string | undefined;

      if (parsed?.scheme === 'job_attachments') {
        jobId = parsed.jobId;
        namePrefix = parsed.name;
      } else if (uri.startsWith(jobPrefix)) {
        const raw = uri.slice(jobPrefix.length);
        if (!raw) {
          throw new Error(`Invalid resource URI: ${uri}`);
        }
        const parts = raw.split('/').filter(Boolean);
        if (parts.length === 0) {
          throw new Error(`Invalid resource URI: ${uri}`);
        }
        jobId = parts.shift();
        namePrefix = parts.join('/');
      }

      if (!jobId) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const result = await requestJson<{ attachments: { name: string }[] }>(
        context,
        `/jobs/${jobId}/attachments`,
      );
      if (namePrefix) {
        const normalized = namePrefix.startsWith('/') ? namePrefix.slice(1) : namePrefix;
        result.attachments = result.attachments.filter((att) => att.name.startsWith(normalized));
      }
      outputJson(result, json);
      return;
    }

    default:
      throw new Error(
        'Usage: eve resources <resolve|ls|cat>\n\n' +
        '  resolve <uri> [--no-content]\n' +
        '  ls <uri-prefix>\n' +
        '  cat <uri>',
      );
  }
}

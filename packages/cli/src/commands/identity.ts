import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type LinkTokenResponse = {
  token: string;
  expires_in: number;
  instructions: string;
};

export async function handleIdentity(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'link': {
      const provider = positionals[0];
      if (!provider) {
        throw new Error('Usage: eve identity link <provider> --org <org_id>\n\nSupported providers: slack');
      }
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const response = await requestJson<LinkTokenResponse>(
        context,
        '/users/me/identity-link-tokens',
        {
          method: 'POST',
          body: { provider, org_id: orgId },
        },
      );

      if (json) {
        outputJson(response, json);
      } else {
        console.log(response.instructions);
      }
      return;
    }
    default:
      throw new Error('Usage: eve identity <link>');
  }
}

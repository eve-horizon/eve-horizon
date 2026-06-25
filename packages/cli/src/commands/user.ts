import type { FlagValue } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type UserShowResponse = {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
  memberships: Array<{
    org_id: string;
    org_name: string;
    org_slug: string;
    role: string;
  }>;
  project_memberships: Array<{
    project_id: string;
    project_name: string;
    project_slug: string;
    org_slug: string;
    role: string;
  }>;
};

export async function handleUser(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'show': {
      const userId = positionals[0] ?? 'me';
      const user = await requestJson<UserShowResponse>(context, `/users/${userId}`);

      if (json) {
        outputJson(user, true);
        return;
      }

      console.log(`User: ${user.email}`);
      if (user.display_name) console.log(`Name: ${user.display_name}`);
      console.log(`ID:   ${user.id}`);
      if (user.is_admin) console.log(`Role: system_admin`);
      console.log(`Since: ${user.created_at?.split('T')[0] ?? ''}`);

      if (user.memberships.length > 0) {
        console.log('\nOrg memberships:');
        for (const m of user.memberships) {
          console.log(`  ${m.org_slug || m.org_name}  ${m.role}`);
        }
      }

      if ((user.project_memberships ?? []).length > 0) {
        console.log('\nProject memberships:');
        for (const pm of user.project_memberships) {
          console.log(`  ${pm.org_slug}/${pm.project_slug}  ${pm.role}`);
        }
      }

      if (user.memberships.length === 0 && (user.project_memberships ?? []).length === 0) {
        console.log('\nNo memberships.');
      }

      return;
    }
    default:
      throw new Error('Usage: eve user <show> [user_id|me]');
  }
}

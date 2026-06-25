import type { FlagValue } from '../lib/args';
import type { ProfileConfig } from '../lib/config';
import {
  loadRepoProfiles,
  saveRepoProfiles,
  removeRepoProfile,
  getRepoProfilePath,
  type RepoProfiles,
} from '../lib/context';
import { outputJson } from '../lib/output';

export function handleProfile(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
): void {
  const json = Boolean(flags.json);
  if (flags.global) {
    throw new Error('Global profiles have been removed. Profiles are repo-local; remove --global.');
  }

  switch (subcommand) {
    case 'list': {
      const repoProfiles = loadRepoProfiles();
      const profiles = Object.entries(repoProfiles.profiles).map(([name, profile]) => ({
        name,
        active: name === repoProfiles.activeProfile,
        ...profile,
      }));

      outputJson({ active_profile: repoProfiles.activeProfile ?? null, profiles }, json);
      return;
    }
    case 'show': {
      const requestedName = positionals[0];
      const repoProfiles = loadRepoProfiles();
      const name = resolveProfileName(repoProfiles, requestedName);
      if (!name) {
        throw new Error('No local profiles configured. Use `eve profile set` to create one.');
      }

      const profile = repoProfiles.profiles[name];
      if (!profile) {
        throw new Error(`Profile ${name} not found`);
      }

      const active = repoProfiles.activeProfile === name;
      outputJson({ name, active, ...profile }, json, `${name} (local)`);
      return;
    }
    case 'use': {
      const isClear = Boolean(flags.clear);

      // Handle --clear: remove local profile
      if (isClear) {
        const removed = removeRepoProfile();
        if (removed) {
          outputJson(
            { cleared: true, path: getRepoProfilePath() },
            json,
            `✓ Removed local profile store (${getRepoProfilePath()})`,
          );
        } else {
          outputJson({ cleared: false }, json, `No local profile to remove`);
        }
        return;
      }

      const name = positionals[0];
      if (!name) {
        throw new Error('Usage: eve profile use <name>');
      }

      const repoProfiles = loadRepoProfiles();
      if (!repoProfiles.profiles[name]) {
        repoProfiles.profiles[name] = {};
      }

      repoProfiles.profiles[name] = applyProfileFlags(repoProfiles.profiles[name], flags);
      repoProfiles.activeProfile = name;
      saveRepoProfiles(repoProfiles);
      outputJson(
        { active_profile: name, path: getRepoProfilePath(), ...repoProfiles.profiles[name] },
        json,
        `✓ Active profile: ${name} (${getRepoProfilePath()})`,
      );
      return;
    }
    case 'create': {
      const name = positionals[0];
      if (!name) {
        throw new Error('Usage: eve profile create <name> [--api-url <url> ...]');
      }
      const repoProfiles = loadRepoProfiles();
      if (repoProfiles.profiles[name]) {
        throw new Error(`Profile ${name} already exists`);
      }
      repoProfiles.profiles[name] = applyProfileFlags({}, flags);
      if (!repoProfiles.activeProfile) {
        repoProfiles.activeProfile = name;
      }
      saveRepoProfiles(repoProfiles);
      outputJson({ name, ...repoProfiles.profiles[name] }, json, `✓ Profile created: ${name}`);
      return;
    }
    case 'set': {
      const repoProfiles = loadRepoProfiles();
      const name = resolveProfileName(repoProfiles, positionals[0]) ?? 'default';
      if (!repoProfiles.profiles[name]) {
        repoProfiles.profiles[name] = {};
      }
      repoProfiles.profiles[name] = applyProfileFlags(repoProfiles.profiles[name], flags);
      repoProfiles.activeProfile = name;
      saveRepoProfiles(repoProfiles);
      outputJson(
        { active_profile: name, ...repoProfiles.profiles[name], path: getRepoProfilePath() },
        json,
        `✓ Profile set: ${name} (${getRepoProfilePath()})`,
      );
      return;
    }
    case 'remove': {
      const name = positionals[0];
      if (!name) {
        throw new Error('Usage: eve profile remove <name>');
      }
      const repoProfiles = loadRepoProfiles();
      if (!repoProfiles.profiles[name]) {
        throw new Error(`Profile ${name} not found`);
      }
      delete repoProfiles.profiles[name];
      if (repoProfiles.activeProfile === name) {
        const [first] = Object.keys(repoProfiles.profiles);
        repoProfiles.activeProfile = first;
      }
      if (!repoProfiles.activeProfile && Object.keys(repoProfiles.profiles).length === 0) {
        removeRepoProfile();
        outputJson({ removed: name, cleared: true }, json, `✓ Removed profile ${name} (store cleared)`);
        return;
      }
      saveRepoProfiles(repoProfiles);
      outputJson(
        { removed: name, active_profile: repoProfiles.activeProfile ?? null },
        json,
        `✓ Removed profile ${name}`,
      );
      return;
    }
    default:
      throw new Error('Usage: eve profile <list|show|use|create|set|remove>');
  }
}

function applyProfileFlags(profile: ProfileConfig, flags: Record<string, FlagValue>): ProfileConfig {
  const updated = { ...profile };
  if (typeof flags['api-url'] === 'string') updated.api_url = flags['api-url'];
  if (typeof flags.org === 'string') updated.org_id = flags.org;
  if (typeof flags.project === 'string') updated.project_id = flags.project;
  if (typeof flags['supabase-url'] === 'string') updated.supabase_url = flags['supabase-url'];
  if (typeof flags['supabase-anon-key'] === 'string') updated.supabase_anon_key = flags['supabase-anon-key'];
  // --harness accepts "harness" or "harness:variant" format
  if (typeof flags.harness === 'string') updated.default_harness = flags.harness;
  // Auth defaults
  if (typeof flags['default-email'] === 'string') updated.default_email = flags['default-email'];
  if (typeof flags['default-ssh-key'] === 'string') updated.default_ssh_key = flags['default-ssh-key'];
  return updated;
}

function resolveProfileName(repoProfiles: RepoProfiles, requestedName?: string): string | undefined {
  if (requestedName) return requestedName;
  if (repoProfiles.activeProfile) return repoProfiles.activeProfile;
  const names = Object.keys(repoProfiles.profiles);
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  if (names.includes('default')) return 'default';
  return names[0];
}

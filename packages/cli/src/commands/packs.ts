import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PackLock } from '@eve/shared';
import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';

/**
 * eve packs <status|resolve> — Manage AgentPack lockfile and resolution.
 */
export async function handlePacks(
  subcommand: string | undefined,
  _rest: string[],
  flags: Record<string, FlagValue>,
  _context: ResolvedContext,
): Promise<void> {
  const repoRoot = resolve(getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir', 'path']) ?? process.cwd());

  switch (subcommand) {
    case 'status': {
      printPacksStatus(repoRoot);
      return;
    }
    case 'resolve': {
      const dryRun = getBooleanFlag(flags, ['dry-run', 'dry_run']) ?? false;
      printPacksResolve(repoRoot, dryRun);
      return;
    }
    default:
      throw new Error('Usage: eve packs <status|resolve>');
  }
}

// ---------------------------------------------------------------------------
// status: read lockfile + manifest, print table, detect drift
// ---------------------------------------------------------------------------

function printPacksStatus(repoRoot: string): void {
  const lockfilePath = join(repoRoot, '.eve', 'packs.lock.yaml');
  const manifestPath = join(repoRoot, '.eve', 'manifest.yaml');

  if (!existsSync(lockfilePath)) {
    console.log('No lockfile found at .eve/packs.lock.yaml');
    console.log('Run "eve project sync" to resolve packs and generate the lockfile.');
    return;
  }

  const lockRaw = readFileSync(lockfilePath, 'utf-8');
  const lock = parseYaml(lockRaw) as PackLock;

  if (!lock || !lock.packs) {
    console.log('Lockfile is empty or malformed.');
    return;
  }

  // Print resolved packs table
  console.log(`Pack lockfile: .eve/packs.lock.yaml`);
  console.log(`Resolved at:   ${lock.resolved_at}`);
  console.log(`Project slug:  ${lock.project_slug}`);
  console.log('');

  if (lock.packs.length === 0) {
    console.log('No packs resolved.');
  } else {
    const idWidth = Math.max(4, ...lock.packs.map((p) => p.id.length));
    const sourceWidth = Math.max(6, ...lock.packs.map((p) => p.source.length));

    const header = [
      padRight('Pack', idWidth),
      padRight('Source', sourceWidth),
      'Ref',
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length + 12));

    for (const pack of lock.packs) {
      console.log([
        padRight(pack.id, idWidth),
        padRight(pack.source, sourceWidth),
        pack.ref.substring(0, 12),
      ].join('  '));
    }
  }

  // Effective config stats
  console.log('');
  console.log('Effective config:');
  console.log(`  Agents: ${lock.effective.agents_count}`);
  console.log(`  Teams:  ${lock.effective.teams_count}`);
  console.log(`  Routes: ${lock.effective.routes_count}`);

  // Drift detection: compare manifest packs to lockfile
  if (existsSync(manifestPath)) {
    const manifestRaw = readFileSync(manifestPath, 'utf-8');
    const manifest = parseYaml(manifestRaw) as Record<string, unknown> | null;
    if (manifest) {
      const xEve =
        (manifest['x-eve'] as Record<string, unknown> | undefined) ??
        (manifest['x_eve'] as Record<string, unknown> | undefined) ??
        {};
      const manifestPacks = (xEve.packs ?? []) as Array<{ source: string; ref?: string }>;

      const drift = detectDrift(lock, manifestPacks);
      if (drift.length > 0) {
        console.log('');
        console.log('WARNING: Drift detected between manifest and lockfile:');
        for (const msg of drift) {
          console.log(`  - ${msg}`);
        }
        console.log('');
        console.log('Run "eve project sync" to re-resolve packs.');
      } else if (manifestPacks.length > 0) {
        console.log('');
        console.log('No drift detected. Lockfile is in sync with manifest.');
      }
    }
  }
}

function detectDrift(
  lock: PackLock,
  manifestPacks: Array<{ source: string; ref?: string }>,
): string[] {
  const drift: string[] = [];

  // Build a map of lockfile packs by source for easy lookup
  const lockBySource = new Map<string, { id: string; ref: string }>();
  for (const lp of lock.packs) {
    lockBySource.set(lp.source, { id: lp.id, ref: lp.ref });
  }

  // Check manifest packs against lockfile
  for (const mp of manifestPacks) {
    const locked = lockBySource.get(mp.source);
    if (!locked) {
      drift.push(`Pack source "${mp.source}" in manifest but not in lockfile`);
    } else if (mp.ref && mp.ref !== locked.ref) {
      drift.push(`Pack "${locked.id}" ref changed: lockfile=${locked.ref.substring(0, 12)} manifest=${mp.ref.substring(0, 12)}`);
    }
  }

  // Check lockfile packs not in manifest
  const manifestSources = new Set(manifestPacks.map((p) => p.source));
  for (const lp of lock.packs) {
    if (!manifestSources.has(lp.source)) {
      drift.push(`Pack "${lp.id}" in lockfile but not in manifest`);
    }
  }

  return drift;
}

// ---------------------------------------------------------------------------
// resolve: delegate to project sync (the resolution pipeline lives there)
// ---------------------------------------------------------------------------

function printPacksResolve(repoRoot: string, dryRun: boolean): void {
  if (dryRun) {
    // Dry-run: show current lockfile state and what would happen
    const lockfilePath = join(repoRoot, '.eve', 'packs.lock.yaml');
    const manifestPath = join(repoRoot, '.eve', 'manifest.yaml');

    if (!existsSync(manifestPath)) {
      throw new Error('No manifest found at .eve/manifest.yaml');
    }

    const manifestRaw = readFileSync(manifestPath, 'utf-8');
    const manifest = parseYaml(manifestRaw) as Record<string, unknown> | null;
    if (!manifest) {
      throw new Error('Manifest is empty or malformed.');
    }

    const xEve =
      (manifest['x-eve'] as Record<string, unknown> | undefined) ??
      (manifest['x_eve'] as Record<string, unknown> | undefined) ??
      {};
    const manifestPacks = (xEve.packs ?? []) as Array<{ source: string; ref?: string }>;

    if (manifestPacks.length === 0) {
      console.log('No packs defined in manifest x-eve.packs. Nothing to resolve.');
      return;
    }

    console.log('Dry run: pack resolution preview');
    console.log('');
    console.log(`Manifest declares ${manifestPacks.length} pack(s):`);
    for (const mp of manifestPacks) {
      const refShort = mp.ref ? mp.ref.substring(0, 12) : '(local)';
      console.log(`  - ${mp.source} @ ${refShort}`);
    }

    if (existsSync(lockfilePath)) {
      const lockRaw = readFileSync(lockfilePath, 'utf-8');
      const lock = parseYaml(lockRaw) as PackLock;
      if (lock?.packs) {
        const drift = detectDrift(lock, manifestPacks);
        if (drift.length > 0) {
          console.log('');
          console.log('Changes that would be applied:');
          for (const msg of drift) {
            console.log(`  - ${msg}`);
          }
        } else {
          console.log('');
          console.log('No changes detected. Lockfile is already in sync.');
        }
      }
    } else {
      console.log('');
      console.log('No existing lockfile. A new lockfile would be created.');
    }

    console.log('');
    console.log('To apply, run: eve project sync');
    return;
  }

  // Non-dry-run: delegate to project sync
  console.log('Pack resolution is integrated into the project sync pipeline.');
  console.log('');
  console.log('Run: eve project sync');
  console.log('');
  console.log('This will resolve packs, merge configs, write the lockfile, and sync to the API.');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

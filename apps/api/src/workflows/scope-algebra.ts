import type { AccessBindingScope } from '@eve/shared';

// Pure scope-intersection algebra used when merging workflow, step, and
// invocation token scopes. Extracted verbatim from WorkflowsService (R-C5).

export function intersectScopes(left: AccessBindingScope, right: AccessBindingScope): AccessBindingScope {
  return {
    ...(left.orgfs || right.orgfs ? { orgfs: intersectPrefixScope(left.orgfs, right.orgfs) } : {}),
    ...(left.orgdocs || right.orgdocs ? { orgdocs: intersectPrefixScope(left.orgdocs, right.orgdocs) } : {}),
    ...(left.envdb || right.envdb ? { envdb: {
      schemas: intersectStringSets(left.envdb?.schemas, right.envdb?.schemas),
      tables: intersectStringSets(left.envdb?.tables, right.envdb?.tables),
    } } : {}),
    ...(left.cloud_fs || right.cloud_fs ? { cloud_fs: {
      allow_mount_ids: intersectStringSets(left.cloud_fs?.allow_mount_ids, right.cloud_fs?.allow_mount_ids),
    } } : {}),
  };
}

export function intersectPrefixScope(
  left: AccessBindingScope['orgfs'],
  right: AccessBindingScope['orgfs'],
): NonNullable<AccessBindingScope['orgfs']> {
  return {
    allow_prefixes: intersectPathPatterns(left?.allow_prefixes, right?.allow_prefixes),
    read_only_prefixes: intersectPathPatterns(left?.read_only_prefixes, right?.read_only_prefixes),
  };
}

export function intersectStringSets(left: string[] | undefined, right: string[] | undefined): string[] {
  if (left === undefined) return [...new Set(right ?? [])].sort();
  if (right === undefined) return [...new Set(left)].sort();
  if (left.includes('*')) return [...new Set(right)].sort();
  if (right.includes('*')) return [...new Set(left)].sort();
  const rightSet = new Set(right);
  return [...new Set(left.filter((item) => rightSet.has(item)))].sort();
}

export function intersectPathPatterns(left: string[] | undefined, right: string[] | undefined): string[] {
  if (left === undefined) return [...new Set(right ?? [])].sort();
  if (right === undefined) return [...new Set(left)].sort();
  const out = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      const intersection = intersectPathPattern(a, b);
      if (intersection) out.add(intersection);
    }
  }
  return [...out].sort();
}

export function intersectPathPattern(a: string, b: string): string | null {
  if (a === '*') return b;
  if (b === '*') return a;
  const aBase = pathPatternBase(a);
  const bBase = pathPatternBase(b);
  if (aBase === bBase) return a.length >= b.length ? a : b;
  if (aBase.startsWith(`${bBase}/`)) return a;
  if (bBase.startsWith(`${aBase}/`)) return b;
  return null;
}

export function pathPatternBase(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === '*' || trimmed === '') return '/';
  return trimmed
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '')
    .replace(/\/+$/, '') || '/';
}

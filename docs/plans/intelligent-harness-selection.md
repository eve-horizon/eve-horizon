# Intelligent Harness Selection

> Status: Planned
> Author: Claude
> Created: 2026-01-28

## Problem

When no harness is explicitly specified on a job, the system falls back to `EVE_DEFAULT_HARNESS` (defaults to `mclaude`). If that harness has no valid credentials, the job fails with a cryptic error. We need intelligent selection that:

1. Picks an available harness based on credential availability
2. Respects configurable preference ordering at project/system levels
3. Provides clear feedback on selection decisions

## Design Overview

### Selection Timing

**Selection happens at orchestrator claim time** (not job creation or worker execution):

| Timing | Why Not |
|--------|---------|
| Job creation | Too early - credentials may change before execution |
| Worker execution | Too late - attempt already created with harness |
| **Orchestrator claim** | Just right - can fail fast with clear message |

### Preference Hierarchy

Resolution order (first non-null wins):

```
1. Explicit harness on job/attempt          → Use it, fail if no auth
2. Project manifest harness_preference      → First available wins
3. System settings harness_preference       → First available wins (from DB)
4. Hardcoded default order                  → First available wins
```

### Default Preference Order

```
zai → claude → codex → gemini
```

Rationale:
- Only include harnesses with **distinct credential sources**
- `mclaude` excluded (shares Anthropic credentials with `claude`)
- `code` excluded (shares OpenAI credentials with `codex`)
- `zai` first (Z.ai - often the primary provider)
- `claude` second (Anthropic)
- `codex` third (OpenAI)
- `gemini` fourth (Google)

## Schema Changes

### 1. System Settings Migration

**Option A: Modify existing migration (if not yet deployed)**

Update `00024_add_system_settings.sql` directly:

```sql
-- Insert harness preference (replaces old default_harness)
INSERT INTO system_settings (key, value, description, updated_by)
VALUES (
  'harness_preference',
  'zai,claude,codex,gemini',
  'Comma-separated harness preference order. First available harness with valid credentials is selected.',
  'system'
)
ON CONFLICT (key) DO NOTHING;
```

**Option B: New migration (if 00024 already deployed)**

```sql
-- packages/db/migrations/00025_harness_preference.sql

-- Remove the old single-harness default
DELETE FROM system_settings WHERE key = 'default_harness';

-- Add preference array (comma-separated)
INSERT INTO system_settings (key, value, description, updated_by)
VALUES (
  'harness_preference',
  'zai,claude,codex,gemini',
  'Comma-separated harness preference order. First available harness with valid credentials is selected.',
  'system'
)
ON CONFLICT (key) DO NOTHING;
```

**Note:** The seed value is just the default - admins can change it via `eve system settings set harness_preference "..."` after deployment.

**CLI usage:**
```bash
# View current preference
eve system settings harness_preference

# Update preference order
eve system settings set harness_preference "claude,zai,codex,gemini"
```

### 2. Manifest Extension

Extend `x-eve.defaults` to support `harness_preference`:

```yaml
# .eve/manifest.yaml
x-eve:
  defaults:
    harness: mclaude                 # Explicit single harness (existing, still works)
    harness_preference:              # NEW: preference order for intelligent selection
      - zai
      - claude
      - codex
```

### 3. Deprecate EVE_DEFAULT_HARNESS

**Remove** `EVE_DEFAULT_HARNESS` from config schema entirely. The `system_settings` table is now the authoritative source for system-level configuration.

## Implementation

### New File: `packages/shared/src/harnesses/select.ts`

Core selection logic:

```typescript
import { resolveHarnessName, type HarnessCanonicalName } from './registry.js';
import { getHarnessAuthStatus } from './auth.js';

export interface HarnessSelectionResult {
  harness: HarnessCanonicalName;
  source: 'explicit' | 'project' | 'system' | 'default';
  checked: string[];
  unavailable: { name: string; reason: string }[];
}

export const DEFAULT_HARNESS_PREFERENCE: HarnessCanonicalName[] = [
  'zai', 'claude', 'codex', 'gemini'
];

export function selectAvailableHarness(options: {
  explicit?: string;
  projectPreference?: string[];
  systemPreference?: string[];
}): HarnessSelectionResult {
  // 1. If explicit harness specified, use it (no fallback - honor user intent)
  if (options.explicit) {
    const canonical = resolveHarnessName(options.explicit);
    if (!canonical) {
      throw new Error(`Unknown harness: ${options.explicit}`);
    }
    return {
      harness: canonical,
      source: 'explicit',
      checked: [canonical],
      unavailable: []
    };
  }

  // 2. Build preference order: project → system → default
  const preference = options.projectPreference
    ?? options.systemPreference
    ?? DEFAULT_HARNESS_PREFERENCE;

  const source: HarnessSelectionResult['source'] = options.projectPreference
    ? 'project'
    : options.systemPreference
      ? 'system'
      : 'default';

  // 3. Find first available harness
  const checked: string[] = [];
  const unavailable: { name: string; reason: string }[] = [];

  for (const name of preference) {
    const canonical = resolveHarnessName(name);
    if (!canonical) continue;

    checked.push(canonical);
    const authStatus = getHarnessAuthStatus(canonical);

    if (authStatus.available) {
      return { harness: canonical, source, checked, unavailable };
    }

    unavailable.push({ name: canonical, reason: authStatus.reason });
  }

  // 4. No available harness - provide helpful error
  const checkedList = checked.join(', ');
  const reasons = unavailable.map(u => `  ${u.name}: ${u.reason}`).join('\n');

  throw new Error(
    `No harness with valid credentials.\n` +
    `Checked: ${checkedList}\n` +
    `Reasons:\n${reasons}\n` +
    `Run 'eve harness list' to see full auth status.`
  );
}
```

### Modify: `packages/shared/src/config/schema.ts`

**Remove** `EVE_DEFAULT_HARNESS` from the config schema.

### Modify: `packages/shared/src/schemas/manifest.ts`

```typescript
export const ManifestDefaultsSchema = z
  .object({
    harness_preference: z.array(z.string()).optional(),  // NEW
    git: ManifestGitDefaultsSchema.optional(),
    workspace: ManifestWorkspaceDefaultsSchema.optional(),
  })
  .passthrough();
```

### Modify: `apps/orchestrator/src/loop/loop.service.ts`

Replace hardcoded fallback (around line 527):

```typescript
// Current code:
const harnessSpec = attempt.harness ?? job.harness ?? this.config.EVE_DEFAULT_HARNESS;

// New code:
import { selectAvailableHarness, DEFAULT_HARNESS_PREFERENCE } from '@eve/shared';
import { systemSettingsQueries } from '@eve/db';

// ... in tick() method:
const manifestDefaults = await this.getManifestDefaults(job.project_id);
const systemPreference = await this.getSystemHarnessPreference();

const selection = selectAvailableHarness({
  explicit: attempt.harness ?? job.harness,
  projectPreference: manifestDefaults?.harness_preference as string[] | undefined,
  systemPreference,
});

const harnessSpec = selection.harness;
console.log(
  `Harness: ${selection.harness} ` +
  `(source: ${selection.source}, checked: ${selection.checked.join(', ')})`
);
```

Add helper methods:

```typescript
private async getManifestDefaults(
  projectId: string
): Promise<Record<string, unknown> | null> {
  const manifests = projectManifestQueries(this.db);
  const manifest = await manifests.findLatestByProject(projectId);
  return manifest?.parsed_defaults ?? null;
}

private async getSystemHarnessPreference(): Promise<string[] | undefined> {
  const settings = systemSettingsQueries(this.db);
  const setting = await settings.get('harness_preference');
  if (!setting?.value) return undefined;
  return setting.value.split(',').map(s => s.trim()).filter(Boolean);
}
```

## Behavior Matrix

| Scenario | Result |
|----------|--------|
| `job.harness = 'mclaude'` | Use mclaude, fail if no auth |
| `job.harness = null`, zai has auth | Use zai (first in preference) |
| `job.harness = null`, zai no auth, claude has auth | Use claude (next available) |
| Project has `harness_preference: [gemini, zai]` | Check gemini first, then zai |
| System settings has `harness_preference: claude,codex` | Check claude first, then codex |
| All harnesses lack auth | Fail with comprehensive error message |

## Example Log Output

```
Harness: claude (source: system, checked: zai, claude)
```

```
Error: No harness with valid credentials.
Checked: zai, claude, codex, gemini
Reasons:
  zai: Z_AI_API_KEY not set
  claude: ANTHROPIC_API_KEY not set and no OAuth credentials found
  codex: OPENAI_API_KEY not set and no OAuth credentials found
  gemini: GEMINI_API_KEY not set
Run 'eve harness list' to see full auth status.
```

## Verification

### Unit Tests

```typescript
// packages/shared/src/harnesses/select.test.ts
describe('selectAvailableHarness', () => {
  it('uses explicit harness without fallback', () => {
    const result = selectAvailableHarness({ explicit: 'mclaude' });
    expect(result.harness).toBe('mclaude');
    expect(result.source).toBe('explicit');
  });

  it('falls back to next available when first lacks auth', () => {
    // Mock getHarnessAuthStatus to return unavailable for zai
    const result = selectAvailableHarness({
      systemPreference: ['zai', 'claude'],
    });
    expect(result.harness).toBe('claude');
    expect(result.unavailable).toContainEqual({
      name: 'zai',
      reason: expect.any(String)
    });
  });

  it('throws when no harness has valid auth', () => {
    expect(() => selectAvailableHarness({
      systemPreference: ['zai'],
    })).toThrow(/No harness with valid credentials/);
  });
});
```

### Manual Verification

```bash
# 1. Check current system preference
eve system settings harness_preference

# 2. Set only ANTHROPIC_API_KEY (zai unavailable, claude available)
export ANTHROPIC_API_KEY=your-key
unset Z_AI_API_KEY

# 3. Verify harness list shows availability
eve harness list
# Should show: zai (unavailable), claude (available)

# 4. Create job without harness
eve job create test-proj "Test intelligent selection"

# 5. Check orchestrator logs
# Should see: "Harness: claude (source: system, checked: zai, claude)"
```

## Migration

### Database Migration
Either:
- **Option A:** Modify `00024_add_system_settings.sql` (if not deployed)
- **Option B:** Add `00025_harness_preference.sql` (if 00024 already deployed)

Both approaches seed `harness_preference = 'zai,claude,codex,gemini'`.

### Config Cleanup
Remove `EVE_DEFAULT_HARNESS` from:
- `packages/shared/src/config/schema.ts`
- `.env.example`
- Any documentation referencing it

### Backwards Compatibility
- If `harness_preference` is not in DB, code falls back to hardcoded default
- Explicit `harness` on job/manifest still works (no fallback behavior)

## Future Enhancements (Not in Scope)

1. **Org-level preferences** - Would store in org metadata or separate table
2. **Cost-aware selection** - Prefer cheaper harnesses when appropriate
3. **Capability matching** - Select based on required features (reasoning, model size)
4. **Per-job-type preferences** - e.g., prefer codex for code review tasks

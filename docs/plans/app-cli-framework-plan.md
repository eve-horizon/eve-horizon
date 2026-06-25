# App CLI Framework

> Status: Complete
> Last Updated: 2026-03-14
>
> Inputs:
> - `docs/plans/agent-api-tool-injection-plan.md` (existing — `eve api call` + `--with-apis`)
> - `../../eve-horizon/eden` (motivating use case — 14 agents, all using curl/fetch)
> - `docs/plans/manual-test-scenarios.md` (Scenario 04 for end-to-end verification)
> - Worker toolchain system (proven init container distribution pattern)
>
> Dependencies:
> - `--with-apis` + `EVE_APP_API_URL_*` injection (implemented)
> - `EVE_JOB_TOKEN` minting (implemented)
> - Manifest `x-eve.api_spec` (implemented)
> - Toolchain init container pattern (implemented)

---

## Problem

Agents interacting with Eve-compatible app REST APIs waste enormous LLM
calls on plumbing. Eden's 14 agents each burn 3-5 calls per API interaction
on URL construction, JSON payload building, shell quoting, and error parsing.
The synthesis agent went from 88 to 37 calls through optimization — but API
interactions remain the dominant source of waste.

**What agents do today:**

```bash
# 1. Discover project ID (1-2 LLM calls)
node --input-type=module -e "
  const API = process.env.EVE_APP_API_URL_API;
  const TOKEN = process.env.EVE_JOB_TOKEN;
  const headers = { 'Authorization': 'Bearer ' + TOKEN };
  const projects = await fetch(API + '/projects', { headers }).then(r => r.json());
  console.log(projects[0].id);
"

# 2. Read current state (1-2 calls, often gets quoting wrong first time)
curl -s "$EVE_APP_API_URL_API/projects/$PID/map" \
  -H "Authorization: Bearer $EVE_JOB_TOKEN" | head -200

# 3. Build and send changeset (3-5 calls — write JSON to file, post it, retry on error)
cat > /tmp/changeset.json << 'PAYLOAD'
{"items":[{"operation":"create","entity_type":"persona","after_state":{"code":"PM",...}}]}
PAYLOAD
curl -X POST "$EVE_APP_API_URL_API/projects/$PID/changesets" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EVE_JOB_TOKEN" \
  -d @/tmp/changeset.json
```

**Pain points:**

| Problem | Cost | Root Cause |
|---------|------|------------|
| URL construction | 1-2 retries | Path prefix confusion, query param encoding |
| JSON payload building | 2-3 retries | Shell quoting, nested JSON escaping |
| Error interpretation | 1-2 retries | HTTP 500 = server error? bad input? auth? |
| Project ID discovery | 1-2 calls per agent | Two ID systems (Eve project ID ≠ app UUID) |
| Auth header boilerplate | Every call | Same 2 lines repeated everywhere |
| Content-Type header | Frequent omission | Easy to forget, silent failures |

**`eve api call` helps but isn't enough.** It handles auth and base URL, but agents
still construct paths, format JSON payloads, and interpret generic HTTP errors. The
problem is that REST APIs are the wrong abstraction level for agent interaction.

---

## Insight

**CLIs are the natural agent interface.** Just as kubectl is how humans (and agents)
interact with Kubernetes — not the API server — app CLIs should be how agents
interact with app services. CLIs provide:

- **Self-documentation**: `eden --help` → discover all capabilities
- **Structured errors**: `"Activity ACT-1 not found"` not `{"statusCode":404}`
- **No URL management**: CLI reads env vars internally
- **No auth boilerplate**: Token injected, invisible to caller
- **No JSON quoting**: `--file /tmp/data.json` or `--title "My task"`
- **Composable output**: `--json` for machine parsing, tables for humans
- **Domain vocabulary**: `eden changeset accept` not `POST /changesets/:id/accept`

**What agents should do:**

```bash
eden projects list
eden map show --project auto
eden changeset create --file /tmp/changes.json
eden changeset accept CS-123
```

Four commands. Zero retries. Zero auth boilerplate. Zero URL construction.

---

## Design

### Core Principle: Apps Ship CLIs, Platform Distributes Them

The platform doesn't generate CLIs or understand app domains. Apps build their
own CLIs using any language/framework. The platform handles:

1. **Declaration** — Manifest tells the platform a CLI exists
2. **Distribution** — Platform makes CLI available in agent workspace
3. **Auto-configuration** — Env vars (API URL + auth token) are pre-set

### Manifest Declaration

```yaml
# .eve/manifest.yaml
services:
  api:
    build:
      context: ./apps/api
    ports: [3000]
    x-eve:
      api_spec:
        type: openapi
      cli:                          # NEW — CLI declaration
        name: eden                  # Binary name (goes on $PATH)
        bin: cli/bin/eden           # Path relative to repo root
```

The `cli` block is a sibling of `api_spec` on the service's `x-eve` extension.
This is natural: a service exposes an API spec *and* a CLI to interact with it.

When an agent job has `with_apis: [api]`, the platform provides both:
- `EVE_APP_API_URL_API` (raw API access, existing)
- `eden` on PATH (CLI access, new)

### Distribution Modes

**Mode 1: Repo-Bundled (Primary — Zero Latency)**

The CLI is a pre-bundled executable in the app repo. Since the workspace already
clones the repo, the CLI is present with zero additional latency.

```
eden/
  cli/
    bin/
      eden            ← Single-file bundle (esbuild output), hashbang #!/usr/bin/env node
    src/
      index.ts        ← Source (compiled to bin/eden during build)
      client.ts       ← API client (reads env vars)
      commands/
        projects.ts
        map.ts
        changesets.ts
    package.json      ← Build script: esbuild → cli/bin/eden
    tsconfig.json
```

**Build step** (run during `npm run build` or CI):
```bash
npx esbuild cli/src/index.ts \
  --bundle --platform=node --target=node20 \
  --format=esm --outfile=cli/bin/eden \
  --banner:js='#!/usr/bin/env node'
chmod +x cli/bin/eden
```

Result: a single self-contained file (~50-200KB) with zero runtime dependencies.
The `node_modules/` directory is not needed at runtime — everything is inlined.

**Platform setup** (during workspace initialization, after clone):
1. Parse manifest → find `x-eve.cli` declarations
2. `chmod +x ${workspace}/cli/bin/eden`
3. `ln -sf ${workspace}/cli/bin/eden /usr/local/bin/eden`
   (or add `${workspace}/cli/bin` to `EVE_APP_CLI_PATHS`, extend PATH in entrypoint)

**Mode 2: Image-Based (Compiled CLIs)**

For apps that ship compiled binaries (Go, Rust) or need platform-specific builds:

```yaml
services:
  api:
    x-eve:
      cli:
        name: myapp
        image: ghcr.io/org/myapp-cli:latest    # Pre-built image
```

Platform injects via init container (identical to toolchain pattern):
```
Init container: ghcr.io/org/myapp-cli:latest
  → cp /cli/bin/myapp /opt/eve/app-cli/myapp/bin/myapp
  → EVE_APP_CLI_PATHS=/opt/eve/app-cli/myapp/bin
  → PATH extended in entrypoint
```

This adds ~2-5s startup (image pull, cached after first run). Same proven
pattern as `EVE_TOOLCHAIN_PATHS`.

### Auto-Configuration Contract

Every app CLI reads these environment variables (already injected by platform):

| Env Var | Source | Purpose |
|---------|--------|---------|
| `EVE_APP_API_URL_{SERVICE}` | Platform (from `resolved_app_apis`) | Base URL of the app API |
| `EVE_JOB_TOKEN` | Platform (minted per job) | Bearer token for auth |
| `EVE_PROJECT_ID` | Platform (from job context) | Eve project ID |
| `EVE_ORG_ID` | Platform (from job context) | Eve org ID |
| `EVE_APP_CLI_PATHS` | Platform (path list) | Additional PATH entries for image-based CLIs |

The CLI should never require manual configuration. If these env vars are missing,
the CLI prints a clear error:

```
Error: EVE_APP_API_URL_API not set.

Are you running inside an Eve job? Make sure the agent config includes:
  with_apis:
    - service: api
```

### CLI Implementation Pattern

Apps implement CLIs using this pattern (no SDK required — just a convention):

```typescript
// cli/src/client.ts — The API client (15 lines, copy-paste)
const SERVICE = 'API'; // matches manifest service name, uppercased

export function getApiUrl(): string {
  const url = process.env[`EVE_APP_API_URL_${SERVICE}`];
  if (!url) {
    console.error(`Error: EVE_APP_API_URL_${SERVICE} not set.`);
    console.error('Are you running inside an Eve job with with_apis: [api]?');
    process.exit(1);
  }
  return url;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const url = getApiUrl();
  const token = process.env.EVE_JOB_TOKEN;
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as Record<string, unknown>));
    const msg = (err as Record<string, string>).message || res.statusText;
    console.error(`${method} ${path} → ${res.status}: ${msg}`);
    process.exit(1);
  }
  return res.json() as Promise<T>;
}
```

```typescript
// cli/src/index.ts — Command definitions
import { Command } from 'commander';
import { api } from './client.js';

const program = new Command();
program.name('eden').description('Eden story map CLI').version('1.0.0');

// ---- projects ----
const projects = program.command('projects');

projects.command('list')
  .description('List all Eden projects')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const data = await api('GET', '/projects');
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    for (const p of data) console.log(`${p.id}  ${p.name}`);
  });

// ---- map ----
program.command('map')
  .description('Show the full story map')
  .argument('[project-id]', 'Project ID (auto-detected if only one)')
  .option('--persona <code>', 'Filter by persona')
  .option('--json', 'JSON output')
  .action(async (projectId, opts) => {
    const pid = projectId || await autoDetect();
    const params = opts.persona ? `?persona=${opts.persona}` : '';
    const map = await api('GET', `/projects/${pid}/map${params}`);
    if (opts.json) return console.log(JSON.stringify(map, null, 2));
    printMap(map); // human-friendly tree output
  });

// ---- changesets ----
const cs = program.command('changeset');

cs.command('create')
  .description('Create a changeset from a JSON file')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--file <path>', 'JSON file with changeset items')
  .action(async (opts) => {
    const body = JSON.parse(await readFile(opts.file, 'utf8'));
    const result = await api('POST', `/projects/${opts.project}/changesets`, body);
    console.log(`Created changeset: ${result.id}`);
  });

cs.command('accept')
  .description('Accept a changeset')
  .argument('<changeset-id>')
  .action(async (id) => {
    await api('POST', `/changesets/${id}/accept`);
    console.log(`Accepted: ${id}`);
  });

program.parse();

async function autoDetect() {
  const projects = await api('GET', '/projects');
  if (projects.length === 1) return projects[0].id;
  console.error('Multiple projects found. Specify --project <id>.');
  console.error(projects.map(p => `  ${p.id}  ${p.name}`).join('\n'));
  process.exit(1);
}
```

### Output Contract

All app CLIs should follow these conventions:

```bash
eden projects list              # Human-readable table by default
eden projects list --json       # Machine-readable JSON

eden map [project-id]           # Pretty-printed tree
eden map [project-id] --json    # Full JSON tree
eden map                        # Alias for default project when only one exists

eden changeset create ...       # Prints: "Created changeset: CS-45"
eden changeset create ... --json  # Prints: {"id":"CS-45","status":"pending",...}
eden changeset show --id ID --json  # Show full changeset payload and items
```

Errors go to stderr, data goes to stdout. Exit code 0 = success, 1 = error.

---

## Implementation

### Phase 1: Manifest Schema + CLI Setup

**Scope**: Platform changes to parse, store, and activate app CLIs.

**1a. Manifest Schema** (`packages/shared/src/schemas/manifest.ts`)

Add `CliSpec` schema to the `x-eve` service extension:

```typescript
export const CliSpecSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, 'CLI name must be lowercase alphanumeric'),
  bin: z.string().min(1),        // Path relative to repo root
  image: z.string().optional(),  // Alternative: Docker image for compiled CLIs
  description: z.string().optional(),
});
```

Add to the service `x-eve` block alongside `api_spec`.

**1b. CLI Info in Resolved Hints** (`packages/shared/src/schemas/api-source.ts`)

Extend `AppApiInfo` to include CLI metadata:

```typescript
export interface AppApiInfo {
  name: string;
  type: string;
  base_url: string;
  cli?: { name: string; bin: string; image?: string };  // NEW
}
```

When `resolveAppApis()` runs, if the service has an `x-eve.cli` declaration,
include it in the resolved info.

**1c. Instruction Block Enhancement** (`buildAppApiInstructionBlock`)

When a service has a CLI, the instruction block should prefer it:

```
**Available App APIs** (env vars injected by platform):
- **api** (openapi): `http://api.svc.cluster.local:3000`
  - CLI: `eden` (on PATH — use `eden --help` to see all commands)
  - Fallback: `curl "$EVE_APP_API_URL_API/..." -H "Authorization: Bearer $EVE_JOB_TOKEN"`
```

Agents naturally gravitate to the CLI when they see `eden --help` in the
instruction block.

**1d. Workspace CLI Setup** (invoke services — agent-runtime + worker)

After repo clone, during workspace initialization:

```typescript
// In both agent-runtime and worker invoke.service.ts
async function setupAppClis(workspace: string, resolvedApis: AppApiInfo[]) {
  for (const api of resolvedApis) {
    if (!api.cli) continue;
    const binPath = path.join(workspace, api.cli.bin);
    if (await fileExists(binPath)) {
      await fs.chmod(binPath, 0o755);
      await fs.rm(`/usr/local/bin/${api.cli.name}`, { force: true });
      await fs.symlink(binPath, `/usr/local/bin/${api.cli.name}`);
      this.logger.log(`App CLI '${api.cli.name}' → ${binPath}`);
      if (api.cli.image) {
        this.logger.warn(`CLI '${api.cli.name}' declared with image + bin fallback; ensure mode handles both paths.`);
      }
    } else {
      this.logger.warn(`App CLI declared but not found: ${binPath}`);
    }
  }
}
```

For image-based CLIs, add init container (same pattern as toolchains):

```typescript
if (api.cli.image) {
  initContainers.push({
    name: `cli-${api.cli.name}`,
    image: api.cli.image,
    command: ['sh', '-c', `mkdir -p /opt/eve/app-cli/${api.cli.name} && cp -a /cli/. /opt/eve/app-cli/${api.cli.name}/`],
    env: [{ name: 'EVE_APP_CLI_PATHS', value: `/opt/eve/app-cli/${api.cli.name}` }],
    volumeMounts: [{ name: 'app-cli', mountPath: `/opt/eve/app-cli/${api.cli.name}`, subPath: api.cli.name }],
  });
}
```

**1e. Entrypoint Enhancement** (`docker/worker/entrypoint.sh`)

```bash
# Extend PATH with app CLIs (image-based)
if [ -n "${EVE_APP_CLI_PATHS:-}" ]; then
  export PATH="${EVE_APP_CLI_PATHS}:${PATH}"
fi
```

### Phase 2: Eden CLI (Reference Implementation)

**Scope**: Build Eden's CLI to prove the pattern works.

```
eden/
  cli/
    package.json            # devDeps: commander, esbuild
    tsconfig.json
    src/
      index.ts              # Entry point, command registration
      client.ts             # API client (~15 lines)
      output.ts             # Table/JSON formatting
      commands/
        projects.ts         # eden projects {list}
        map.ts              # eden map [project-id] [--persona] [--json]
        changesets.ts       # eden changeset {create,show,accept,reject,review,list}
        personas.ts         # eden persona {list,create}
        questions.ts        # eden question {list,show,evolve}
        search.ts           # eden search <query>
        export.ts           # eden export {json,markdown}
    bin/
      eden                  # Built artifact (gitignored? or committed for zero-build)
```

**Command inventory** (matches Eden's API surface):

```
eden projects list                          # List projects
eden map [project-id]                       # Show story map tree
eden map --project PID --json                # Show story map for explicit project id
eden changeset create --project PID --file  # Create changeset from JSON
eden changeset show --id ID                  # Show one changeset and its items
eden changeset accept ID                    # Accept changeset
eden changeset reject ID                    # Reject changeset
eden changeset list --project PID           # List changesets
eden persona list --project PID             # List personas
eden question list --project PID            # List open questions
eden question show QID                      # Show question details
eden search QUERY --project PID             # Full-text search
eden export json --project PID              # Export as JSON
eden export markdown --project PID          # Export as Markdown
```

All commands support `--json` for machine output. Project ID auto-detected when
only one project exists.

**Build step** (added to Eden's CI or `package.json`):

```json
{
  "scripts": {
    "build:cli": "esbuild cli/src/index.ts --bundle --platform=node --target=node20 --format=esm --outfile=cli/bin/eden --banner:js='#!/usr/bin/env node' && chmod +x cli/bin/eden"
  }
}
```

**Manifest update**:

```yaml
services:
  api:
    x-eve:
      api_spec:
        type: openapi
      cli:
        name: eden
        bin: cli/bin/eden
```

### Phase 3: Agent Skill Updates (Eden)

Update Eden's agent skills to use CLI instead of curl/fetch:

**Before** (coordinator/SKILL.md):
```bash
curl -s "$EVE_APP_API_URL_API/projects" \
  -H "Authorization: Bearer $EVE_JOB_TOKEN" | jq '.[0].id'
```

**After**:
```bash
eden projects list --json | jq '.[0].id'
# Or simply:
eden map --json > /tmp/current-map.json
```

**Before** (synthesis/SKILL.md):
```bash
cat > /tmp/changeset.json << 'PAYLOAD'
{"items":[...]}
PAYLOAD
curl -X POST "$EVE_APP_API_URL_API/projects/$PID/changesets" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EVE_JOB_TOKEN" \
  -d @/tmp/changeset.json
```

**After**:
```bash
eden changeset create --project $PID --file /tmp/changeset.json
```

### Phase 3b: Verification Loop — Eden k3d Adoption (MANDATORY)

Before finalizing Phase 3, run this loop end-to-end:

1. **Add CLI to Eden repo** (`~/dev/eve-horizon/eden`)

   - Add `cli/` (or existing CLI) implementation and build artifact at
     `cli/bin/eden` (executable).
   - Update `.eve/manifest.yaml`:
   ```yaml
   services:
     api:
       x-eve:
         api_spec:
           type: openapi
         cli:
           name: eden
           bin: cli/bin/eden
   ```
   - Build/check:
   ```bash
   cd ~/dev/eve-horizon/eden
   pnpm install
   cd cli
   pnpm install
   pnpm run build:cli
   chmod +x bin/eden
   ```

2. **Install into local k3d stack**

   ```bash
   cd ~/dev/eve-horizon/eve-horizon
   ./bin/eh status
   # Use your team-approved project-ensure syntax if flags differ
   PROJECT_ID=$(eve project list --json | jq -r '.[] | select(.repo_url | contains("eve-horizon/eden")) | .id' | head -n 1)
   if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "null" ]; then
     PROJECT_ID=$(eve project ensure --name eden --slug eden --repo-url ~/dev/eve-horizon/eden --branch main --json | jq -r '.id')
   fi
   eve env deploy "$PROJECT_ID" sandbox --tag local
   ```

3. **Migrate Eden skills from REST/fetch to CLI**

   In `~/dev/eve-horizon/eden`, replace callsites in these files:
   - `skills/coordinator/SKILL.md`
   - `skills/map-chat/SKILL.md`
   - `skills/synthesis/SKILL.md`
   - `skills/question/SKILL.md`
   - `skills/alignment/SKILL.md`

   Then verify no remaining direct REST/fetch examples in core flow files:
   ```bash
   rg -n "Use `curl`|\\$EVE_APP_API_URL_API|fetch\\(" ~/dev/eve-horizon/eden/skills --glob '**/SKILL.md'
   ```

4. **Use one manual scenario as acceptance validation**

   Run Scenario 04 (`docs/plans/manual-test-scenarios.md`) through CLI equivalents
   after the k3d deploy above:

   ```bash
   cd ~/dev/eve-horizon/eden
   export PATH="~/dev/eve-horizon/eden/cli/bin:${PATH}"
   export EVE_JOB_TOKEN="$(eve auth token --raw)"
   # For a local k3d run, export the Eden base URL used by your stack
   # e.g. https://eden.example-eden-sandbox.eve.example.com
   export EVE_APP_API_URL_API="${EDEN_URL%/}/api"

   PID=$(eden projects list --json | jq -r '.[0].id')
   cat > /tmp/changeset.json <<'JSON'
   {"title":"CLI smoke change","reasoning":"Smoke validation","source":"manual-test","items":[{"entity_type":"step","operation":"create","after_state":{"name":"Security Review","display_id":"STP-2.3","activity_ref":"ACT-2","sort_order":3},"description":"CLI smoke test"}]}
   JSON
   CS_ID=$(eden changeset create --project "$PID" --file /tmp/changeset.json --json | jq -r '.id')
   eden changeset show --id "$CS_ID" --json
   eden changeset accept "$CS_ID"
   eden projects list --json | jq '.'
   ```

If any iteration fails, fix the corresponding manifest, setup, or skill usage issue,
then repeat steps 2–4.

### Phase 4: Eve Skillpack — Teaching the Pattern

Create `eve-app-cli` skill in `eve-skillpacks/eve-se/` that teaches app
developers how to build CLIs for their Eve apps. Also add `app-cli.md`
reference to `eve-read-eve-docs`.

See **Skills & Documentation** section below.

---

## Architecture: End-to-End Flow

```
┌─ App Developer ──────────────────────────────────────────────┐
│                                                              │
│  1. Write CLI (commander + fetch wrapper)                    │
│  2. Bundle with esbuild → cli/bin/eden                       │
│  3. Declare in manifest: x-eve.cli.name + x-eve.cli.bin      │
│  4. Commit and deploy                                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─ Eve Platform (existing + small changes) ────────────────────┐
│                                                              │
│  5. Manifest sync → stores CLI metadata alongside api_spec   │
│  6. Job created with with_apis: [api]                        │
│      → resolveAppApis() includes cli info in resolved hints  │
│      → instruction block says "use eden --help"              │
│  7. Workspace setup (after clone):                           │
│      → chmod +x ${workspace}/cli/bin/eden                    │
│      → symlink to /usr/local/bin/eden                        │
│  8. Env vars injected:                                       │
│      EVE_APP_API_URL_API=http://api.svc:3000                 │
│      EVE_JOB_TOKEN=eyJ...                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─ Agent ──────────────────────────────────────────────────────┐
│                                                              │
│  9.  eden --help          → discover capabilities            │
│  10. eden map             → read current state               │
│  11. eden changeset create --file /tmp/changes.json          │
│  12. eden changeset accept CS-45                             │
│                                                              │
│  Zero URL construction. Zero auth headers. Zero JSON quoting.│
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Skills & Documentation

### New Skill: `eve-app-cli` (eve-skillpacks/eve-se/)

Teaches app developers how to build CLIs for their Eve apps:

1. **Why**: Agents waste calls on REST plumbing; CLIs are the right abstraction
2. **How**: Node.js + commander pattern, env var contract, output conventions
3. **Build**: esbuild bundling for zero-dependency distribution
4. **Declare**: Manifest `x-eve.cli` block
5. **Test**: Local testing with env vars set manually

### New Reference: `app-cli.md` (eve-read-eve-docs/references/)

Technical reference covering:

- Manifest schema for CLI declaration
- Env var contract (`EVE_APP_API_URL_*`, `EVE_JOB_TOKEN`)
- CLI implementation pattern (client.ts, commands, output)
- Bundling guide (esbuild)
- Image-based distribution (for compiled CLIs)
- Testing patterns

### Update: `eve-read-eve-docs` Index

Add `app-cli.md` to the task router and intent coverage matrix:

- "build app CLI" → `app-cli.md`
- "agent API interaction" → `app-cli.md` + `manifest.md`
- "reduce agent LLM calls" → `app-cli.md`

---

## Comparison: CLI vs `eve api call` vs Raw Fetch

| Dimension | App CLI | `eve api call` | Raw curl/fetch |
|-----------|---------|-----------------|----------------|
| Auth handling | Invisible | Automatic | Manual headers |
| URL construction | None | Partial (need path) | Full URL |
| JSON payloads | `--file` flag | `--json` flag | Shell quoting hell |
| Error messages | Domain-specific | HTTP status codes | HTTP status codes |
| Discoverability | `--help` at every level | `eve api spec` | Read docs |
| LLM calls per op | 1 | 1-2 | 3-5 |
| Setup required | Manifest declaration | `--with-apis` | Nothing |
| Language support | Any (bundled binary) | Any (CLI) | Any |

**Recommendation**: App CLI is the primary interface. `eve api call` is the
fallback for ad-hoc exploration. Raw fetch should never be needed.

---

## Risk & Mitigations

| Risk | Mitigation |
|------|------------|
| CLI binary not found after clone | Platform logs warning; agents fall back to `eve api call` |
| CLI has runtime dependencies | Bundling requirement eliminates deps; skill teaches esbuild |
| Name collision (two services both name CLI "app") | Validation during manifest sync; CLI names must be unique per project |
| CLI out of sync with API | Same repo, same build — CLI and API evolve together |
| Startup latency (image mode) | Image pull cached after first run; same latency as toolchains |

---

## What This Does NOT Cover

- **CLI generation from OpenAPI specs**: The platform doesn't auto-generate CLIs.
  Apps build CLIs that match their domain vocabulary, not HTTP endpoints.
- **MCP server injection**: Future enhancement. Could generate MCP servers from
  OpenAPI specs for harnesses that support them.
- **Cross-project CLIs**: CLIs are scoped to their project. Cross-project access
  is a separate concern.
- **CLI versioning/updates**: CLI is in the repo, versioned with git. No separate
  versioning scheme needed.

---

## Code Surface

| Area | Key Files | Change |
|------|-----------|--------|
| Manifest schema | `packages/shared/src/schemas/manifest.ts` | Add `CliSpecSchema` to service x-eve |
| API source | `packages/shared/src/schemas/api-source.ts` | Add `cli?` to `AppApiInfo`, update instruction block |
| Jobs service | `apps/api/src/jobs/jobs.service.ts` | Include CLI info in `resolveAppApis()` |
| Agent-runtime invoke | `apps/agent-runtime/src/invoke/invoke.service.ts` | `setupAppClis()` after clone |
| Worker invoke | `apps/worker/src/invoke/invoke.service.ts` | `setupAppClis()` after clone |
| K8s runner | `apps/*/src/invoke/k8s-runner.ts` | Init containers for image-based CLIs |
| Entrypoint | `docker/worker/entrypoint.sh` | `EVE_APP_CLI_PATHS` extension |
| Eve skillpacks | `eve-se/eve-app-cli/SKILL.md` | New skill |
| Eve docs | `eve-read-eve-docs/references/app-cli.md` | New reference |
| Eden CLI | `../../eve-horizon/eden/cli/` | Reference implementation |
| Eden manifest | `../../eve-horizon/eden/.eve/manifest.yaml` | Add `x-eve.cli` block on `api` |
| Eden skills | `../../eve-horizon/eden/skills/**/SKILL.md` | Replace direct REST/fetch with CLI usage |

---

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Manifest + CLI setup | 1-2 days | None |
| Phase 2: Eden CLI | 1-2 days | Phase 1 (or can start in parallel using env vars directly) |
| Phase 3: Agent skill updates | 0.5 day | Phase 2 |
| Phase 4: Eve skillpack | 0.5 day | Phase 2 (needs concrete examples) |

Total: ~3-5 days for end-to-end implementation and documentation.

Phase 2 (Eden CLI) can start immediately — it only needs `EVE_APP_API_URL_API`
and `EVE_JOB_TOKEN`, which are already injected. The manifest declaration and
platform symlink (Phase 1) add convenience but aren't blockers.

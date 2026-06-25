# Eve Horizon CLI

Published CLI (npx) for interacting with the Eve Horizon API. Dev/ops tooling lives in `./bin/eh`.

```bash
npx @eve/cli --help
```

## Local Development & Global Parity

When testing CLI changes locally, you have two options:

```bash
# Option 1: run the repo-local build directly
pnpm -C packages/cli build
node packages/cli/bin/eve.js --help

# Option 2: link the CLI so the global `eve` binary matches your local build
pnpm -C packages/cli build
cd packages/cli && npm link
eve --help
```

To update global installs for others, publish a new CLI version via the `cli-v*` tag flow
(see root AGENTS.md for release instructions).

## Philosophy

The CLI is the **primary interface** for Eve Horizon, designed for humans and AI agents. The REST API is the substrate: every operation is exposed via HTTP, and the CLI is a thin wrapper that handles argument parsing and output formatting. It does not bypass the API or contain business logic.

See [API Philosophy](../../docs/system/api-philosophy.md) and [OpenAPI](../../docs/system/openapi.md).

## Profiles (repo-local defaults)

Profiles store API URL, default org/project IDs, default harness, and Supabase auth config.
Profiles are **repo-local** and live in `.eve/profile.yaml` so each project keeps its own
defaults without impacting other checkouts.

```bash
# Create or update a profile (repo-local)
eve profile set local \
  --api-url http://localhost:4801 \
  --org org_defaulttestorg \
  --project proj_xxx

# Set default harness (with optional variant)
eve profile set --harness mclaude
eve profile set --harness mclaude:fast   # harness with variant

# Set active profile (repo-local)
eve profile use local

# Show active profile
eve profile show
```

Profile harness defaults are used when scheduling jobs.
The `--harness` flag accepts `harness` or `harness:variant` format everywhere.
Priority: `--harness` flag > job hints > profile default > system default.

### Supabase config (cloud auth)

Store Supabase settings in a profile (recommended for cloud stacks):

```bash
eve profile set prod \
  --api-url https://api.eve-horizon.example.com \
  --supabase-url https://your-project.supabase.co \
  --supabase-anon-key <anon-key>
```

## Auth

Auth is **required** for cloud stacks. The default flow uses GitHub SSH keys; Supabase remains an
optional adapter for legacy deployments.

Credentials are stored globally in `~/.eve/credentials.json`, keyed by API URL. The CLI will
refresh Supabase access tokens automatically if a refresh token is available.

```bash
# SSH login (default)
eve auth login --email you@example.com --ssh-key ~/.ssh/id_ed25519

# SSH login with custom token TTL (1-90 days)
eve auth login --email you@example.com --ttl 30

# Supabase login (optional)
eve auth login --email you@example.com --password '...' \
  --supabase-url https://your-project.supabase.co \
  --supabase-anon-key <anon-key>

# Status / whoami
eve auth status
eve auth whoami

# Logout
eve auth logout
```

## Commands

### Organizations

```bash
eve org ensure "My Org"
eve org list
eve org get org_xxx
eve org update org_xxx --name "New Name"
```

### Projects

```bash
eve project ensure --name my-project --slug MyProj
eve project ensure --name my-project --slug MyProj --repo-url https://github.com/org/repo
eve project list
eve project get proj_xxx
```

### Jobs

Jobs follow a phase-based lifecycle: `idea` → `backlog` → `ready` → `active` → `review` → `done`

Jobs created without a `--phase` flag default to `ready`, making them immediately schedulable.

```bash
# Create a job (defaults to ready phase)
eve job create --description "Fix the login bug in auth.ts"
eve job create --description "Add dark mode" --priority 1 --harness mclaude

# Create a job with git controls
eve job create \
  --description "Fix checkout" \
  --git-ref main \
  --git-branch job/fix-checkout \
  --git-create-branch if_missing \
  --git-commit auto \
  --git-push on_success

# List and filter jobs
eve job list --phase ready
eve job ready                    # Schedulable jobs (ready, not blocked)
eve job blocked                  # Jobs waiting on dependencies

# View job details
eve job show MyProj-abc123
eve job tree MyProj-abc123       # Hierarchical view

# Update jobs
eve job update MyProj-abc123 --phase active --assignee agent-1
eve job close MyProj-abc123 --reason "Work completed"
eve job cancel MyProj-abc123 --reason "No longer needed"

# Dependencies
eve job dep add MyProj-abc123 MyProj-def456   # abc123 depends on def456
eve job dep list MyProj-abc123

# Claim/release workflow (typically used by scheduler/agents)
eve job claim MyProj-abc123 --harness mclaude
eve job release MyProj-abc123 --reason "Need more info"
eve job attempts MyProj-abc123

# Job execution and monitoring
eve job logs MyProj-abc123
eve job result MyProj-abc123 --format full    # Get job results (text|json|full)
eve job result MyProj-abc123 --attempt 2      # Get results from specific attempt
eve job wait MyProj-abc123 --timeout 300      # Wait for job completion
eve job wait MyProj-abc123 --quiet --json     # Wait quietly, JSON output
eve job follow MyProj-abc123                  # Stream logs in real-time via SSE
eve job follow MyProj-abc123 --raw            # Stream raw JSON lines
eve job follow MyProj-abc123 --no-result      # Stream logs without final result

# Review workflow
eve job submit MyProj-abc123 --summary "Implemented fix"
eve job approve MyProj-abc123 --comment "LGTM"
eve job reject MyProj-abc123 --reason "Missing tests"
```

### Workflows

```bash
eve workflow list --project proj_xxx
eve workflow run proj_xxx make-plan --input '{"slug":"plan-slug"}'
eve workflow invoke proj_xxx qa-review --input '{"task":"audit"}'

# Retry only the failed/current tail of a terminal workflow root
eve workflow retry acme-fd842fff --failed
eve workflow retry acme-fd842fff --from review
```

### Agents

```bash
# Inspect agent policy + harness readiness
eve agents config --json

# Sync agents/teams/chat config from repo (deterministic)
eve agents sync --project proj_xxx --ref main

# Local dev sync (requires local API + allow dirty)
eve agents sync --project proj_xxx --local --allow-dirty
```

### Integrations + Chat

```bash
# Connect Slack workspace (stub OAuth)
eve integrations slack connect --org org_xxx --team-id T123 --token xoxb-...

# List integrations for org
eve integrations list --org org_xxx

# Send a non-chat Slack/channel notification from a workflow or job
eve notifications send --project proj_xxx --channel eve-horizon-notifications --message "Workflow complete"

# Simulate inbound Slack message
eve chat simulate --project proj_xxx --team-id T123 --channel-id C123 --user-id U123 --text "hello"
```

#### Job Results

Fetch and display completed job results:

```bash
# Show full job result (default format)
eve job result MyProj-abc123

# Get results in different formats
eve job result MyProj-abc123 --format text    # Plain text output only
eve job result MyProj-abc123 --format json    # Full JSON structure
eve job result MyProj-abc123 --format full    # Formatted with metadata (default)

# Get results from a specific attempt
eve job result MyProj-abc123 --attempt 2
```

#### Waiting for Job Completion

Block until a job completes, with optional timeout:

```bash
# Wait for job to complete (default timeout: 300s)
eve job wait MyProj-abc123

# Custom timeout (max 300s enforced by API)
eve job wait MyProj-abc123 --timeout 120

# Quiet mode (no progress output)
eve job wait MyProj-abc123 --quiet

# JSON output format
eve job wait MyProj-abc123 --json
```

Exit codes:
- `0`: Job completed successfully
- `1`: Job failed
- `124`: Timeout reached
- `125`: Job was cancelled

#### Real-time Log Streaming

Stream job logs in real-time using Server-Sent Events (SSE):

```bash
# Stream logs with timestamps and formatted output
eve job follow MyProj-abc123

# Stream raw JSON lines (for parsing/filtering)
eve job follow MyProj-abc123 --raw

# Stream logs without printing final result
eve job follow MyProj-abc123 --no-result
```

The `follow` command connects to the job's SSE endpoint and displays logs as they are generated. It shows:
- Timestamps for each log entry
- Tool names and actions

### Secrets

Secrets can be stored at user/org/project scope. Values are never returned in plaintext; `show` returns a masked value.

```bash
# Project secret
eve secrets set GITHUB_TOKEN ghp_xxx --project proj_xxx --type github_token

### System (Internal)

```bash
eve system orchestrator status
eve system orchestrator set-concurrency <n>
```
eve secrets list --project proj_xxx
eve secrets show GITHUB_TOKEN --project proj_xxx
eve secrets delete GITHUB_TOKEN --project proj_xxx

# Import host secrets from .env
eve secrets import --project proj_xxx --file .env
```
- Formatted, human-readable output

Use `--raw` for programmatic consumption or when piping to other tools.

#### Scheduling Hints

Jobs can include hints for the scheduler:

```bash
eve job create --description "Heavy computation" \
  --harness mclaude:fast \
  --worker-type gpu \
  --permission auto_edit \
  --timeout 7200
```

#### Creating Sub-Jobs (for agents)

Agents can create and optionally claim sub-jobs inline:

```bash
# Create sub-job under parent
eve job create --parent MyProj-abc123 --description "Implement feature X"

# Create and immediately claim (for inline execution)
eve job create --parent $EVE_JOB_ID --description "Sub-task" --claim
```

Environment variables for agent context:
- `EVE_PROJECT_ID` - Current project
- `EVE_JOB_ID` - Current job being executed
- `EVE_ATTEMPT_ID` - Current attempt UUID
- `EVE_AGENT_ID` - Agent identifier

### Harnesses

```bash
eve harness list              # List available harnesses
eve harness get mclaude       # Show harness details and auth status
eve harness list --capabilities  # Include model/reasoning capability hints
eve harness validate --project proj_xxx --profile-file profile.json
eve harness validate --project proj_xxx --env-override ANTHROPIC_BASE_URL='${secret.CLAUDE_BASE_URL}'
```

### Agents (Orchestration Config)

Provide policy + harness context for orchestrating agents (profiles, councils, availability):

```bash
eve agents config --json
eve agents config --path /path/to/repo --no-harnesses
```

Recommended default policy profile name: `primary-orchestrator`.

## Pagination

List endpoints accept `--limit` and `--offset`. Default limit is **10**, newest first.

```bash
eve job list --limit 10 --offset 20
```

## Dev CLI

Local dev/ops tooling:

```bash
./bin/eh --help
./bin/eh dev start
./bin/eh k8s start     # Default runtime
./bin/eh docker start  # Quick dev loop
```

/**
 * Progressive help system for Eve Horizon CLI.
 *
 * Help is available at every level:
 * - eve --help              → top-level commands
 * - eve profile --help      → profile subcommands
 * - eve profile set --help  → specific usage
 */

export interface CommandHelp {
  description: string;
  usage: string;
  subcommands?: Record<string, SubcommandHelp>;
  examples?: string[];
}

export interface SubcommandHelp {
  description: string;
  usage: string;
  options?: string[];
  examples?: string[];
}

export const HELP: Record<string, CommandHelp> = {
  org: {
    description: 'Manage organizations. Organizations group projects and users.',
    usage: 'eve org <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List all organizations',
        usage: 'eve org list [--limit N] [--offset N]',
        options: [
          '--limit <n>          Number of results (default: 10)',
          '--offset <n>         Skip first n results',
          '--include-deleted    Include soft-deleted orgs',
        ],
      },
      get: {
        description: 'Get organization details',
        usage: 'eve org get <org_id>',
      },
      ensure: {
        description: 'Create org if it doesn\'t exist, or return existing',
        usage: 'eve org ensure <name> [--slug <slug>] [--id <id>]',
        options: [
          '--slug <slug>        Organization slug (used in URLs)',
          '--id <id>            Organization ID override (optional)',
        ],
        examples: ['eve org ensure "My Company" --slug myco'],
      },
      update: {
        description: 'Update organization',
        usage: 'eve org update <org_id> [--name <name>] [--deleted <bool>]',
      },
      delete: {
        description: 'Soft-delete an organization',
        usage: 'eve org delete <org_id>',
        examples: ['eve org delete org_xxx'],
      },
      members: {
        description: 'Manage organization members (list, add, remove)',
        usage: 'eve org members [list|add|remove] [options]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--email <email>      Email for add',
          '--role <role>        Role: member, admin, owner (default: member)',
        ],
        examples: [
          'eve org members --org org_xxx',
          'eve org members add user@example.com --role admin --org org_xxx',
          'eve org members remove user_abc --org org_xxx',
        ],
      },
      invite: {
        description: 'Create an org invite and optionally send a web-auth email',
        usage: 'eve org invite <email> --org <org_id> [--project <project_id>] [--role member|admin|owner] [--redirect-to <url>] [--no-email]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--project <id>       Project whose manifest branding should be used',
          '--role <role>        Role: member, admin, owner (default: member)',
          '--redirect-to <url>  Final app URL after invite redemption',
          '--no-email           Create invite record without sending email',
        ],
        examples: [
          'eve org invite user@example.com --org org_xxx',
          'eve org invite user@example.com --org org_xxx --project proj_xxx --redirect-to https://app.example.com',
        ],
      },
    },
    examples: [
      'eve org ensure "Acme Corp"',
      'eve org list --limit 20',
      'eve org delete org_xxx',
      'eve org members --org org_xxx',
      'eve org invite user@example.com --org org_xxx --project proj_xxx',
    ],
  },

  project: {
    description: 'Manage projects. Projects link a git repo to an organization for running jobs.',
    usage: 'eve project <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List projects in an organization',
        usage: 'eve project list [--org <org_id>]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--limit <n>          Number of results',
          '--offset <n>         Skip first n results',
        ],
      },
      get: {
        description: 'Get project details',
        usage: 'eve project get <project_id>',
      },
      ensure: {
        description: 'Create project if it doesn\'t exist, or return existing',
        usage: 'eve project ensure --name <name> [--repo-url <url>] [--org <org_id>] [--branch <branch>] [--slug <slug>]',
        options: [
          '--name <name>        Project name (required)',
          '--repo-url <url>     Git repository URL (optional, can be set later)',
          '--org <id>           Organization ID',
          '--branch <branch>    Default branch (default: main)',
          '--slug <slug>        Short memorable slug (4-8 chars, e.g., MyProj)',
          '--force              Re-clone repo even if project exists',
        ],
        examples: [
          'eve project ensure --name my-app --slug MyApp',
          'eve project ensure --name my-app --slug MyApp --repo-url https://github.com/org/repo',
          'eve project ensure --name my-app --repo-url file:///path/to/repo --force  # dev/test only',
        ],
      },
      update: {
        description: 'Update project',
        usage: 'eve project update <project_id> [--name <name>] [--repo-url <url>] [--branch <branch>] [--deleted <bool>]',
      },
      sync: {
        description: 'Sync manifest and agents config from local .eve/ to Eve API',
        usage: 'eve project sync [--project <id>] [--dir <path>] [--ref <sha|branch>] [--local]',
        options: [
          '--project <id>        Project ID (uses profile default or manifest "project:" field)',
          '--dir <path>          Working directory (default: cwd)',
          '--ref <ref>           Git ref for agents sync (default: auto-detect HEAD)',
          '--local               Dev-mode local sync (only for localhost/lvh.me API)',
          '--allow-dirty         Allow syncing a dirty working tree',
          '--force-nonlocal      Allow --local against non-local API URL',
          '--validate-secrets    Validate manifest required secrets',
          '--strict              Fail sync if required secrets are missing',
          '--json                Machine-readable JSON output',
        ],
        examples: [
          'eve project sync',
          'eve project sync --project proj_xxx',
          'eve project sync --ref main',
          'eve project sync --local --allow-dirty',
        ],
      },
      image: {
        description: 'Build project-local helper images',
        usage: 'eve project image build-cli [project-slug|project-id] [--repo-dir <path>] [--dockerfile <path>] [--tag <image>] [--import-to-k3d]',
        options: [
          '--repo-dir <path>     Producer checkout (default: cwd)',
          '--dockerfile <path>   CLI Dockerfile (default: Dockerfile.cli)',
          '--tag <image>         Override image tag',
          '--import-to-k3d       Import the built image into the eve-local k3d cluster',
          '--json                Machine-readable JSON output',
        ],
        examples: [
          'eve project image build-cli prod --import-to-k3d',
          'eve project image build-cli --project prod --repo-dir ../producer --dockerfile ../producer/Dockerfile.cli',
        ],
      },
      status: {
        description: 'Show deployment status across all profiles with revision info, service URLs, and deploy age',
        usage: 'eve project status [--profile <name>] [--env <name>] [--json]',
        options: [
          '--profile <name>     Show only this profile',
          '--env <name>         Show only this environment',
          '--json               Machine-readable JSON output',
        ],
        examples: [
          'eve project status',
          'eve project status --profile staging',
          'eve project status --env sandbox --json',
        ],
      },
      members: {
        description: 'Manage project members (list, add, remove)',
        usage: 'eve project members [list|add|remove] [options]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--email <email>      Email for add',
          '--role <role>        Role: member, admin, owner (default: member)',
        ],
        examples: [
          'eve project members --project proj_xxx',
          'eve project members add user@example.com --role admin --project proj_xxx',
          'eve project members remove user_abc --project proj_xxx',
        ],
      },
      'auth-context': {
        description: 'Show resolved app auth context for a project (redirect allowlist, org access, domain signup). Project admins see the full domain_signup domain list; other callers see a hidden bool.',
        usage: 'eve project auth-context <project_id> [--json]',
        options: [
          '--json               Machine-readable JSON output',
        ],
        examples: [
          'eve project auth-context proj_abc',
          'eve project auth-context proj_abc --json',
        ],
      },
    },
  },

  manifest: {
    description: 'Validate project manifests for schema and required secrets.',
    usage: 'eve manifest <subcommand> [options]',
    subcommands: {
      validate: {
        description: 'Validate a manifest (schema + secrets)',
        usage: 'eve manifest validate [--project <id>] [--path <path>] [--latest]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--path <path>        Path to manifest (default: .eve/manifest.yaml)',
          '--latest             Validate latest synced manifest instead of local file',
          '--validate-secrets   Validate required secrets (from manifest)',
          '--strict             Fail validation if required secrets are missing',
        ],
        examples: [
          'eve manifest validate',
          'eve manifest validate --project proj_xxx',
          'eve manifest validate --latest --project proj_xxx',
        ],
      },
    },
  },

  domain: {
    description: 'Manage custom domains for Eve-deployed services.',
    usage: 'eve domain <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List custom domains, optionally scoped to an environment',
        usage: 'eve domain list [--env <name>] [--project <id>] [--json]',
      },
      register: {
        description: 'Register a custom domain imperatively',
        usage: 'eve domain register <hostname> --project <id> --service <service> [--env <env>] [--json]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--service <service>  Service name that should receive traffic',
          '--env <env>          Optional environment name or ID to bind as owner',
          '--json               Machine-readable JSON output',
        ],
        examples: [
          'eve domain register app.example.com --project proj_xxx --service web --env prod',
        ],
      },
      status: {
        description: 'Show domain ownership, DNS state, and cert state',
        usage: 'eve domain status <hostname> [--project <id>] [--json]',
      },
      verify: {
        description: 'Verify DNS resolution and update activation status',
        usage: 'eve domain verify <hostname> [--project <id>] [--json]',
      },
      transfer: {
        description: 'Move domain ownership to another environment in the same project',
        usage: 'eve domain transfer <hostname> --to <env> [--project <id>] [--json]',
      },
      unbind: {
        description: 'Clear env binding so the next deploy can claim it',
        usage: 'eve domain unbind <hostname> [--project <id>] [--json]',
      },
      remove: {
        description: 'Remove a custom domain entirely',
        usage: 'eve domain remove <hostname> [--project <id>] [--json]',
      },
    },
    examples: [
      'eve project sync --dir .',
      'eve domain list --project proj_xxx',
      'eve domain register app.example.com --project proj_xxx --service web --env prod',
    ],
  },

  secrets: {
    description: 'Manage secrets at system/org/user/project scope. Values are never returned in plaintext.',
    usage: 'eve secrets <subcommand> [options]',
    subcommands: {
      set: {
        description: 'Create or update a secret value',
        usage: 'eve secrets set <key> <value> [--system|--project <id>|--org <id>|--user <id>] [--type <type>]',
        options: [
          '--system             System scope (admin only)',
          '--project <id>       Project ID (uses profile default)',
          '--org <id>           Organization ID',
          '--user <id>          User ID',
          '--type <type>        env_var | file | github_token | ssh_key',
        ],
      },
      list: {
        description: 'List secrets (metadata only)',
        usage: 'eve secrets list [--system|--project <id>|--org <id>|--user <id>]',
        options: [
          '--system             System scope (admin only)',
          '--project <id>       Project ID (uses profile default)',
          '--org <id>           Organization ID',
          '--user <id>          User ID',
        ],
      },
      show: {
        description: 'Show a masked secret value',
        usage: 'eve secrets show <key> [--system|--project <id>|--org <id>|--user <id>]',
        options: [
          '--system             System scope (admin only)',
          '--project <id>       Project ID (uses profile default)',
          '--org <id>           Organization ID',
          '--user <id>          User ID',
        ],
      },
      delete: {
        description: 'Delete a secret',
        usage: 'eve secrets delete <key> [--system|--project <id>|--org <id>|--user <id>]',
        options: [
          '--system             System scope (admin only)',
          '--project <id>       Project ID (uses profile default)',
          '--org <id>           Organization ID',
          '--user <id>          User ID',
        ],
      },
      import: {
        description: 'Import env entries from an env file',
        usage: 'eve secrets import [--file <path>] [--system|--project <id>|--org <id>|--user <id>]',
        options: [
          '--file <path>        Defaults to .env',
          '--system             System scope (admin only)',
          '--project <id>       Project ID (uses profile default)',
          '--org <id>           Organization ID',
          '--user <id>          User ID',
        ],
      },
      validate: {
        description: 'Validate manifest-required secrets for a project',
        usage: 'eve secrets validate --project <id> [--keys <k1,k2>]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--keys <k1,k2>       Explicit keys to validate (default: latest manifest)',
        ],
      },
      ensure: {
        description: 'Ensure safe secrets exist at project scope',
        usage: 'eve secrets ensure --project <id> --keys <k1,k2>',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--keys <k1,k2>       Keys to ensure (allowlist only)',
        ],
      },
      export: {
        description: 'Export safe secrets for external configuration',
        usage: 'eve secrets export --project <id> --keys <k1,k2> [--json]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--keys <k1,k2>       Keys to export (allowlist only)',
          '--json               JSON output',
        ],
      },
    },
    examples: [
      'eve secrets set GITHUB_TOKEN ghp_xxx --project proj_xxx --type github_token',
      'eve secrets show GITHUB_TOKEN --project proj_xxx',
      'eve secrets validate --project proj_xxx',
      'eve secrets ensure --project proj_xxx --keys GITHUB_WEBHOOK_SECRET',
      'eve secrets export --project proj_xxx --keys GITHUB_WEBHOOK_SECRET',
    ],
  },

  job: {
    description: `Manage jobs. Jobs are units of work executed by AI agents against a project's repo.

Phase lifecycle: idea → backlog → ready → active → review → done (or cancelled)
Jobs default to 'ready' phase, making them immediately schedulable.`,
    usage: 'eve job <subcommand> [options]',
    subcommands: {
      create: {
        description: 'Create a new job',
        usage: 'eve job create --project <id> --description "..." [options]',
        options: [
          '--project <id>         Project ID (or use profile default)',
          '--description <text>   Work description/prompt (required)',
          '--title <text>         Title (auto-generated from description if omitted)',
          '--parent <id>          Parent job ID (for sub-jobs)',
          '--type <type>          Issue type: task, bug, feature, epic, chore (default: task)',
          '--priority <0-4>       Priority P0-P4 (default: 2)',
          '--phase <phase>        Initial phase (default: ready)',
          '--review <type>        Review requirement: none, human, agent (default: none)',
          '--labels <a,b,c>       Comma-separated labels',
          '--assignee <id>        Assign to agent/user',
          '--defer-until <date>   Hide until date (ISO 8601)',
          '--due-at <date>        Deadline (ISO 8601)',
          '--env <name>           Environment name for persistent execution',
          '--execution-mode <mode> Execution mode: persistent|ephemeral',
          '',
          'Harness selection (top-level job fields):',
          '--harness <name>       Preferred harness, e.g., mclaude',
          '--profile <name>       Harness profile name',
          '--harness-profile <name> Alias for --profile',
          '--harness-override-file <path> Inline profile override JSON file',
          '--env-override KEY=VALUE Per-job env override; repeatable',
          '--variant <name>       Harness variant preset',
          '--model <name>         Model override for harness',
          '--reasoning <level>    Reasoning effort: low|medium|high|x-high',
          '',
          'Scheduling hints (used by scheduler when claiming):',
          '--worker-type <type>   Worker type preference',
          '--permission <policy>  Permission policy: default, auto_edit, yolo',
          '--timeout <seconds>    Execution timeout',
          '--resource-class <rc>  Compute SKU (e.g., job.c1, job.c2)',
          '--max-cost <amount>    Authoritative budget cap in job currency',
          '--max-cost-currency <ccy> Budget currency (default: usd)',
          '--max-tokens <n>       Coarse token guardrail; discounts cache reads',
          '--hint KEY=VALUE       Generic scheduling hint; repeatable',
          '',
          'Inline execution (for agents creating sub-jobs):',
          '--claim                Create and immediately claim the job',
          '--agent <id>           Agent ID for claim (default: $EVE_AGENT_ID)',
          '',
          'Git controls (optional, override project/manifest defaults):',
          '--git-ref <ref>              Target ref (branch, tag, or SHA)',
          '--git-ref-policy <policy>    auto|env|project_default|explicit',
          '--git-branch <branch>        Branch to create/checkout',
          '--git-create-branch <mode>   never|if_missing|always',
          '--git-commit <policy>        never|manual|auto|required',
          '--git-commit-message <text>  Commit message template',
          '--git-push <policy>          never|on_success|required',
          '--git-remote <remote>        Remote to push to (default: origin)',
          '',
          'Workspace options:',
          '--workspace-mode <mode>      job|session|isolated (default: job)',
          '--workspace-key <key>        Workspace key for session mode',
        ],
        examples: [
          'eve job create --description "Fix the login bug in auth.ts"',
          'eve job create --description "Add dark mode" --priority 1 --harness mclaude',
          'eve job create --parent MyProj-abc123 --description "Implement tokens" --claim',
          'eve job create --description "Feature branch work" --git-branch feature/new-api --git-push on_success',
          '# --max-cost is the authoritative budget; --max-tokens discounts cache reads by rate-card weight.',
        ],
      },
      list: {
        description: 'List jobs in a project',
        usage: 'eve job list [--project <id>] [--phase <phase>] [--assignee <id>] [--since <time>] [--stuck] [--all --org <id>]',
        options: [
          '--project <id>       Project ID (or use profile default)',
          '--all                Admin mode: list across projects',
          '--org <id>           Org filter for --all',
          '--phase <phase>      Filter by phase',
          '--assignee <id>      Filter by assignee',
          '--priority <n>       Filter by priority',
          '--since <time>       Filter jobs created after time (e.g., "1h", "30m", "2d", or ISO timestamp)',
          '--stuck              Show only jobs stuck in active phase (no progress for 5+ min)',
          '--stuck-minutes <n>  Minutes threshold for stuck detection (default: 5)',
          '--limit <n>          Number of results (default: 50)',
          '--offset <n>         Skip first n results',
        ],
        examples: [
          'eve job list --phase active',
          'eve job list --since 1h',
          'eve job list --stuck',
          'eve job list --all --org org_xxx',
        ],
      },
      ready: {
        description: 'Show schedulable jobs (ready phase, not blocked, not deferred)',
        usage: 'eve job ready [--project <id>] [--limit <n>]',
        options: [
          '--project <id>       Project ID (or use profile default)',
          '--limit <n>          Number of results (default: 10)',
        ],
      },
      blocked: {
        description: 'Show jobs blocked by dependencies',
        usage: 'eve job blocked [--project <id>]',
        options: [
          '--project <id>       Project ID (or use profile default)',
        ],
      },
      show: {
        description: 'Get job details',
        usage: 'eve job show <job-id> [--verbose]',
        options: [
          '--verbose            Include attempt details, exit codes, durations',
        ],
        examples: ['eve job show MyProj-abc123', 'eve job show MyProj-abc123 --verbose'],
      },
      current: {
        description: 'Get the current job context (defaults to EVE_JOB_ID)',
        usage: 'eve job current [<job-id>] [--json|--tree]',
        options: [
          '--tree               Render job hierarchy instead of JSON',
        ],
        examples: ['eve job current', 'eve job current MyProj-abc123 --tree'],
      },
      diagnose: {
        description: 'Comprehensive job debugging (state, attempts, timeline, logs, recommendations)',
        usage: 'eve job diagnose <job-id>',
        examples: ['eve job diagnose MyProj-abc123'],
      },
      tree: {
        description: 'Show job hierarchy (parent + children)',
        usage: 'eve job tree <job-id>',
        examples: ['eve job tree MyProj-abc123'],
      },
      update: {
        description: 'Update job fields',
        usage: 'eve job update <job-id> [--phase <phase>] [--priority <n>] ...',
        options: [
          '--phase <phase>       Transition phase (validated)',
          '--priority <n>        Set priority (0-4)',
          '--assignee <id>       Set assignee',
          '--title <text>        Update title',
          '--description <text>  Update description',
          '--labels <a,b,c>      Set labels',
          '--defer-until <date>  Set defer date',
          '--due-at <date>       Set due date',
          '--review <type>       Set review requirement',
          '',
          'Git controls (optional, override project/manifest defaults):',
          '--git-ref <ref>              Target ref (branch, tag, or SHA)',
          '--git-ref-policy <policy>    auto|env|project_default|explicit',
          '--git-branch <branch>        Branch to create/checkout',
          '--git-create-branch <mode>   never|if_missing|always',
          '--git-commit <policy>        never|manual|auto|required',
          '--git-commit-message <text>  Commit message template',
          '--git-push <policy>          never|on_success|required',
          '--git-remote <remote>        Remote to push to (default: origin)',
          '',
          'Workspace options:',
          '--workspace-mode <mode>      job|session|isolated (default: job)',
          '--workspace-key <key>        Workspace key for session mode',
        ],
        examples: [
          'eve job update MyProj-abc123 --git-branch feature/work --git-push on_success',
          'eve job update MyProj-abc123 --workspace-mode session --workspace-key session:123',
        ],
      },
      close: {
        description: 'Mark job as done',
        usage: 'eve job close <job-id> [--reason "..."]',
        options: [
          '--reason <text>      Completion reason',
        ],
      },
      cancel: {
        description: 'Mark job as cancelled',
        usage: 'eve job cancel <job-id> [--reason "..."]',
        options: [
          '--reason <text>      Cancellation reason',
        ],
      },
      dep: {
        description: 'Manage job dependencies',
        usage: 'eve job dep <add|remove|list> [args]',
        options: [
          'add <from> <to>      Add dependency: from depends on to',
          'remove <from> <to>   Remove dependency',
          'list <job-id>        Show dependencies and dependents',
        ],
        examples: [
          'eve job dep add MyProj-abc123 MyProj-def456',
          'eve job dep list MyProj-abc123',
        ],
      },
      claim: {
        description: 'Claim a job for execution (creates attempt, transitions to active)',
        usage: 'eve job claim <job-id> [--agent <id>] [--harness <name>]',
        options: [
          '--agent <id>         Agent identifier (default: $EVE_AGENT_ID or cli-user)',
          '--harness <name>     Harness to use (overrides job harness)',
          '',
          'NOTE: This is typically called by the scheduler or by agents creating',
          'sub-jobs. For normal workflows, jobs are auto-scheduled when ready.',
        ],
      },
      release: {
        description: 'Release a claimed job (ends attempt, returns to ready)',
        usage: 'eve job release <job-id> [--agent <id>] [--reason "..."]',
        options: [
          '--agent <id>         Agent identifier (default: $EVE_AGENT_ID or cli-user)',
          '--reason <text>      Release reason',
        ],
      },
      attempts: {
        description: 'List execution attempts for a job',
        usage: 'eve job attempts <job-id>',
      },
      logs: {
        description: 'View execution logs for a job attempt',
        usage: 'eve job logs <job-id> [--attempt <n>] [--after <seq>]',
        options: [
          '--attempt <n>        Attempt number (default: latest)',
          '--after <seq>        Return logs after sequence number',
        ],
      },
      submit: {
        description: 'Submit job for review',
        usage: 'eve job submit <job-id> --summary "..."',
        options: [
          '--summary <text>     Submission summary (required)',
          '--agent-id <id>      Agent ID (default: cli-user)',
        ],
      },
      approve: {
        description: 'Approve a job in review',
        usage: 'eve job approve <job-id> [--comment "..."]',
        options: [
          '--comment <text>     Approval comment',
          '--reviewer-id <id>   Reviewer ID (default: cli-user)',
        ],
      },
      reject: {
        description: 'Reject a job in review (creates new attempt)',
        usage: 'eve job reject <job-id> --reason "..."',
        options: [
          '--reason <text>      Rejection reason (required)',
          '--reviewer-id <id>   Reviewer ID (default: cli-user)',
        ],
      },
      result: {
        description: 'Get job execution result',
        usage: 'eve job result <job-id> [--format text|json|full] [--attempt <n>]',
        options: [
          '--format <mode>      Output format: text|json|full (default: text)',
          '--attempt <n>        Attempt number (default: latest)',
        ],
        examples: ['eve job result MyProj-abc123'],
      },
      wait: {
        description: 'Wait for job completion, polling until done',
        usage: 'eve job wait <job-id> [--timeout <seconds>] [--quiet] [--verbose] [--json]',
        options: [
          '--timeout <seconds>  Max wait time (default: 300)',
          '--quiet              Suppress progress output',
          '--verbose            Show phase/status transitions',
          '--json               Output JSON summary',
        ],
        examples: ['eve job wait MyProj-abc123', 'eve job wait MyProj-abc123 --timeout 600'],
      },
      follow: {
        description: 'Stream job logs in real-time (SSE)',
        usage: 'eve job follow <job-id> [--raw] [--no-result]',
        options: [
          '--raw                Show raw log entries',
          '--no-result          Don\'t fetch final result when done',
        ],
        examples: ['eve job follow MyProj-abc123'],
      },
      watch: {
        description: 'Combined status polling + log streaming',
        usage: 'eve job watch <job-id>',
        examples: ['eve job watch MyProj-abc123'],
      },
      'runner-logs': {
        description: 'Stream runner pod logs (kubectl required)',
        usage: 'eve job runner-logs <job-id>',
        examples: ['eve job runner-logs MyProj-abc123'],
      },
      batch: {
        description: 'Create a batch job graph from a JSON definition',
        usage: 'eve job batch --project <id> --file <path> [--json]',
        options: [
          '--project <id>       Project ID (or use profile default)',
          '--file <path>        Path to JSON batch definition (required)',
          '--json               Output raw JSON response',
        ],
        examples: [
          'eve job batch --project proj_xxx --file batch.json',
          'eve job batch --file batch.json --json',
        ],
      },
      'batch-validate': {
        description: 'Validate a batch job graph definition without creating jobs',
        usage: 'eve job batch-validate --project <id> --file <path> [--json]',
        options: [
          '--project <id>       Project ID (or use profile default)',
          '--file <path>        Path to JSON batch definition (required)',
          '--json               Output raw JSON response',
        ],
        examples: [
          'eve job batch-validate --project proj_xxx --file batch.json',
        ],
      },
    },
    examples: [
      'eve job create --description "Fix the bug in auth.ts"',
      'eve job list --phase ready',
      'eve job show MyProj-abc123',
      'eve job close MyProj-abc123 --reason "Completed"',
      'eve job batch --file batch.json',
    ],
  },

  harness: {
    description: 'Inspect available harnesses, variants, and auth status.',
    usage: 'eve harness <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List available harnesses',
        usage: 'eve harness list [--capabilities]',
        options: [
          '--capabilities      Show model/reasoning capability hints',
        ],
      },
      get: {
        description: 'Get harness details and auth requirements',
        usage: 'eve harness get <name>',
        examples: ['eve harness get mclaude'],
      },
      validate: {
        description: 'Dry-run an inline harness profile override or workflow harness env composition for a project',
        usage: 'eve harness validate --project <proj_xxx> [--profile-file profile.json|--workflow <name>] [--env-override KEY=VALUE]',
        options: [
          '--project <id>           Project ID',
          '--profile-file <file>    JSON object with harness/model/reasoning fields',
          '--workflow <name>        Validate workflow steps without creating jobs',
          '--env-override KEY=VALUE Validate an environment override; repeatable',
          '--json                   Print the validation report as JSON',
        ],
        examples: [
          'eve harness validate --project proj_123 --profile-file profile.json',
          'eve harness validate --project proj_123 --env-override ANTHROPIC_BASE_URL=${secret.CLAUDE_BASE_URL}',
          'eve harness validate --project proj_123 --workflow qa-review --env-override WEB_SEARCH_API_KEY=${secret.WEB_SEARCH_API_KEY}',
        ],
      },
    },
    examples: ['eve harness list', 'eve harness get mclaude', 'eve harness validate --project proj_123 --profile-file profile.json'],
  },

  agents: {
    description: 'Inspect agent policy config and harness capabilities for orchestration. Default profile: primary-orchestrator.',
    usage: 'eve agents <config|sync|runtime-status> [options]',
    subcommands: {
      config: {
        description: 'Show agent policy, resolved agent/team/route summary, and harness availability',
        usage: 'eve agents config [--path <dir>] [--no-harnesses] [--json]',
        options: [
          '--path <dir>        Repository root to inspect (default: cwd)',
          '--repo-dir <dir>    Alias for --path',
          '--no-harnesses      Skip harness availability lookup',
          '--json              Output raw JSON response',
        ],
        examples: [
          'eve agents config',
          'eve agents config --json',
          'eve agents config --path ../my-repo',
          'eve agents config also reports resolved agents, teams, and chat_routes',
        ],
      },
      sync: {
        description: '[Deprecated] Use "eve project sync" instead. Syncs manifest + agents config.',
        usage: 'eve agents sync [--project <id>] [--ref <sha|branch>] [--dir <path>]',
        options: [
          '--project <id>      Project ID (uses profile default)',
          '--ref <ref>         Git ref for agents sync (default: auto-detect HEAD)',
          '--local             Dev-mode local sync (only for localhost/lvh.me API)',
          '--allow-dirty       Allow syncing a dirty working tree',
          '--dir <path>        Working directory (default: cwd)',
          '--force-nonlocal    Allow --local against non-local API URL',
        ],
        examples: [
          'eve project sync                                    # preferred',
          'eve agents sync --project proj_xxx --ref main       # deprecated',
        ],
      },
      'runtime-status': {
        description: 'Show agent runtime status for an org',
        usage: 'eve agents runtime-status [--org <id>]',
        options: [
          '--org <id>          Organization ID (uses profile default)',
        ],
        examples: [
          'eve agents runtime-status --org org_xxx',
          'eve agents runtime-status --json',
        ],
      },
    },
    examples: [
      'eve agents config --json',
      'eve project sync                                  # replaces "eve agents sync"',
      'eve agents runtime-status --org org_xxx',
    ],
  },

  profile: {
    description: `Manage repo-local CLI profiles. Profiles store defaults (API URL, org, project) so you don't
have to specify them on every command.

Profiles live in .eve/profile.yaml inside the repo, so each project keeps its own defaults
and switching profiles won't affect other checkouts.`,
    usage: 'eve profile <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List all profiles',
        usage: 'eve profile list',
      },
      show: {
        description: 'Show profile details',
        usage: 'eve profile show [name]',
        examples: ['eve profile show', 'eve profile show prod'],
      },
      use: {
        description: 'Switch active profile (repo-local)',
        usage: 'eve profile use <name> [--org <id>] [--project <id>]',
        options: [
          '--org <id>             Set org override',
          '--project <id>         Set project override',
          '--api-url <url>        Set API URL override',
          '--clear                Remove local .eve/profile.yaml (clears all profiles)',
        ],
        examples: [
          'eve profile use staging --org org_xxx --project proj_yyy',
          'eve profile use --clear',
        ],
      },
      create: {
        description: 'Create a new named profile (repo-local)',
        usage: 'eve profile create <name> [--api-url <url>] [--org <id>] [--project <id>]',
        options: [
          '--api-url <url>           API base URL',
          '--org <id>                Default organization ID',
          '--project <id>            Default project ID',
          '--harness <name>          Default harness (e.g., mclaude:fast)',
          '--supabase-url <url>      Supabase URL (for cloud auth)',
          '--supabase-anon-key <key> Supabase anon key',
          '--default-email <email>   Default email for auth login',
          '--default-ssh-key <path>  Default SSH key path for auth login',
        ],
        examples: [
          'eve profile create local --api-url http://localhost:4801',
          'eve profile create prod --api-url https://api.example.com --org org_xxx',
        ],
      },
      set: {
        description: 'Update profile settings (repo-local)',
        usage: 'eve profile set [name] [--org <id>] [--project <id>]',
        options: [
          '--org <id>                Default organization ID',
          '--project <id>            Default project ID',
          '--api-url <url>           API base URL',
          '--harness <name>          Default harness',
          '--supabase-url <url>      Supabase URL',
          '--supabase-anon-key <key> Supabase anon key',
          '--default-email <email>   Default email for auth login',
          '--default-ssh-key <path>  Default SSH key path for auth login',
        ],
        examples: [
          'eve profile set --org org_xxx --project proj_yyy',
          'eve profile set staging --org org_xxx --project proj_yyy',
          'eve profile set --default-email user@example.com',
        ],
      },
      remove: {
        description: 'Remove a named profile (repo-local)',
        usage: 'eve profile remove <name>',
      },
    },
    examples: [
      'eve profile set --org org_xxx --project proj_yyy     # writes .eve/profile.yaml',
      'eve profile use staging --org org_xxx                 # writes .eve/profile.yaml',
      'eve profile set --default-email me@dev.com            # writes .eve/profile.yaml',
    ],
  },

  auth: {
    description: `Authenticate with Eve Horizon. Auth is optional for local development but required
for cloud deployments. Credentials are stored globally per API URL.`,
    usage: 'eve auth <login|logout|status|whoami|bootstrap|sync|creds|verify|token|mint|permissions|request-access>',
    subcommands: {
      login: {
        description: 'Login via GitHub SSH challenge (default) or Supabase (legacy)',
        usage: 'eve auth login [--email <email>] [--ssh-key <path>] [--ttl <days>]',
        options: [
          '--email <email>         Email address for SSH login (uses profile default_email if not provided)',
          '--user-id <id>          User id for SSH login',
          '--ssh-key <path>        Path to SSH private key (auto-discovers from ~/.ssh/ if omitted)',
          '--ttl <days>            Token TTL in days (1-90, default: server configured)',
          '--password <pass>       Supabase password (triggers Supabase login)',
          '--supabase-url <url>    Supabase URL',
          '--supabase-anon-key <key> Supabase anon key',
        ],
        examples: [
          'eve auth login --email user@example.com',
          'eve auth login --email user@example.com --ttl 30',
          'eve auth login  # uses profile defaults if set',
          'eve auth login --ssh-key ~/.ssh/id_rsa',
        ],
      },
      logout: {
        description: 'Clear stored credentials',
        usage: 'eve auth logout',
      },
      status: {
        description: 'Check authentication status',
        usage: 'eve auth status',
      },
      whoami: {
        description: 'Show current user info',
        usage: 'eve auth whoami',
      },
      token: {
        description: 'Print the current access token to stdout for sharing with reviewers or use in scripts',
        usage: 'eve auth token [--print]',
        options: [
          '--print             Explicitly request token print (default behavior)',
        ],
        examples: [
          'eve auth token',
          'TOKEN=$(eve auth token)',
          'curl -H "Authorization: Bearer $(eve auth token)" https://api.example.com',
          'eve auth token | pbcopy  # Copy to clipboard',
          'eve auth token  # Share with reviewers for PR preview access',
        ],
      },
      mint: {
        description: 'Mint a user token (admin-only, no SSH login required)',
        usage: 'eve auth mint --email <email> [--org <org_id> | --project <project_id>] [--role <role>] [--ttl <days>]',
        options: [
          '--email <email>     Target user email (created if missing)',
          '--org <org_id>      Org scope for membership and permission checks',
          '--project <id>      Project scope for membership and permission checks',
          '--role <role>       Role to assign (member|admin), default member',
          '--ttl <days>        Token TTL in days (1-90, default: server configured)',
        ],
        examples: [
          'eve auth mint --email app-bot@example.com --org org_xxx',
          'eve auth mint --email app-bot@example.com --project proj_xxx',
          'eve auth mint --email app-bot@example.com --project proj_xxx --role admin',
          'eve auth mint --email bot@example.com --org org_xxx --ttl 90',
        ],
      },
      bootstrap: {
        description: 'Bootstrap the first admin user with flexible security modes',
        usage: 'eve auth bootstrap --email <email> [--token <token>] [options]',
        options: [
          '--email <email>      Admin email address (required for bootstrap)',
          '--token <token>      Bootstrap token (required in secure mode, or use EVE_BOOTSTRAP_TOKEN)',
          '--ssh-key <path>     Path to SSH public key (default: ~/.ssh/id_ed25519.pub)',
          '--display-name <name> Display name for the admin user',
          '--status             Check bootstrap status instead of bootstrapping',
          '',
          'Bootstrap modes (configured server-side via BOOTSTRAP_MODE):',
          '  auto-open          Token not required during initial window (default for new installs)',
          '  recovery           Like auto-open, but for disaster recovery scenarios',
          '  secure             Token always required (recommended for production)',
          '  closed             Bootstrap disabled (use database seeding instead)',
        ],
        examples: [
          'eve auth bootstrap --status',
          'eve auth bootstrap --email admin@example.com',
          'eve auth bootstrap --email admin@example.com --token secret123',
          'EVE_BOOTSTRAP_TOKEN=secret123 eve auth bootstrap --email admin@example.com',
          'eve auth bootstrap --email admin@example.com --ssh-key ~/.ssh/id_rsa.pub',
        ],
      },
      sync: {
        description: 'Extract OAuth tokens from host and set as Eve secrets',
        usage: 'eve auth sync [--claude] [--codex] [--org <id>] [--project <id>] [--dry-run]',
        options: [
          '--claude           Only extract Claude/Anthropic tokens',
          '--codex            Only extract Codex/OpenAI tokens',
          '--org <id>         Set as org-level secrets',
          '--project <id>     Set as project-level secrets',
          '--dry-run          Show what would be set without actually setting',
          '',
          'Scope priority: --project > --org > user (default)',
          'Default scope is user-level, so credentials are available to all your jobs.',
          '',
          'Token type guidance:',
          '  Tokens starting with sk-ant-oat01-* are long-lived setup-tokens (preferred).',
          '  A warning is emitted when syncing any other Claude token (short-lived OAuth,',
          '  ~15h). Generate a long-lived token with: claude setup-token',
          '  Codex/Code auth.json is refresh-validated before CODEX_AUTH_JSON_B64 is',
          '  written. If refresh fails, re-login with: codex login --device-auth',
          '  Codex/Code tokens are automatically written back to their originating secret',
          '  scope after each job when the CLI refreshes them during the session.',
        ],
        examples: [
          'eve auth sync                    # Sync to user-level (default)',
          'eve auth sync --org org_xxx      # Sync to org-level',
          'eve auth sync --project proj_xxx # Sync to project-level',
          'eve auth sync --dry-run          # Preview without syncing',
        ],
      },
      creds: {
        description: 'Show local AI tool credentials (Claude Code, Codex/Code) without syncing to Eve',
        usage: 'eve auth creds [--claude] [--codex]',
        options: [
          '--claude           Only check Claude/Anthropic credentials',
          '--codex            Only check Codex/OpenAI credentials',
          '',
          'Shows token type for Claude (setup-token = long-lived, oauth = short-lived ~15h)',
          'and access/refresh usability for Codex/Code auth.json credentials.',
        ],
        examples: [
          'eve auth creds',
          'eve auth creds --claude',
          'eve auth creds --json',
        ],
      },
      verify: {
        description: 'Run a managed Claude auth probe job and report the selected credential',
        usage: 'eve auth verify --harness claude --project <id> [--timeout 300] [--json]',
        options: [
          '--harness <name>    Claude-family harness to verify (claude|mclaude, default claude)',
          '--project <id>      Project whose resolved secrets should be verified',
          '--timeout <sec>     Max wait time for the probe job (default 300)',
          '--json              Emit structured verdict with secret key, scope, token class, and apiKeySource',
        ],
        examples: [
          'eve auth verify --harness claude --project proj_xxx --json',
          'eve auth verify --harness mclaude --project proj_xxx',
        ],
      },
      permissions: {
        description: 'Show the permission matrix (which permissions each role has)',
        usage: 'eve auth permissions',
        examples: [
          'eve auth permissions',
          'eve auth permissions --json',
        ],
      },
      'request-access': {
        description: 'Self-service access request — submit your SSH key and wait for admin approval',
        usage: 'eve auth request-access --org "<org name>" [--ssh-key <path>] [--email <email>] [--wait]',
        options: [
          '--org <name>          Organization to request access to (required)',
          '--org-slug <slug>     Preferred org slug',
          '--ssh-key <path>      Path to SSH public key (default: ~/.ssh/id_ed25519.pub)',
          '--email <email>       Contact email',
          '--nostr-pubkey <hex>  Nostr public key (alternative to SSH)',
          '--wait                Poll until approved, then auto-login',
          '--status <id>         Check status of an existing request',
        ],
        examples: [
          'eve auth request-access --org "Acme Corp" --ssh-key ~/.ssh/id_ed25519.pub --wait',
          'eve auth request-access --org "Acme Corp" --email user@example.com --wait',
          'eve auth request-access --status <request_id>',
        ],
      },
    },
  },

  access: {
    description: `Manage access control: check permissions, manage roles/bindings, and sync policy-as-code from .eve/access.yaml.`,
    usage: 'eve access <subcommand> [options]',
    subcommands: {
      can: {
        description: 'Check if a principal can perform an action',
        usage: 'eve access can --org <org_id> (--user <id>|--service-principal <id>|--group <id>) --permission <perm> [--project <project_id>] [--resource-type <type> --resource <id> --action <read|write|admin>]',
        options: [
          '--org <org_id>                Org scope (uses profile default if omitted)',
          '--user <user_id>              User to check (mutually exclusive with --service-principal/--group)',
          '--service-principal <sp_id>   Service principal to check (mutually exclusive with --user/--group)',
          '--group <group_id>            Group to check directly (mutually exclusive with --user/--service-principal)',
          '--permission <perm>           Permission to check (e.g., chat:write, jobs:admin)',
          '--project <project_id>        Optional project scope for the check',
          '--resource-type <type>        Optional resource type: orgfs|orgdocs|envdb',
          '--resource <id>               Optional resource id/path (required when --resource-type used)',
          '--action <action>             Optional action: read|write|admin',
        ],
        examples: [
          'eve access can --org org_xxx --user user_abc --permission chat:write',
          'eve access can --org org_xxx --user user_abc --project proj_xxx --permission jobs:admin',
          'eve access can --org org_xxx --service-principal sp_xxx --permission jobs:read',
          'eve access can --org org_xxx --user user_abc --permission orgfs:read --resource-type orgfs --resource /groups/pm/spec.md --action read',
        ],
      },
      explain: {
        description: 'Explain the permission resolution chain',
        usage: 'eve access explain --org <org_id> (--user <id>|--service-principal <id>|--group <id>) --permission <perm> [--project <project_id>] [--resource-type <type> --resource <id> --action <read|write|admin>]',
        options: [
          '--org <org_id>                Org scope (uses profile default if omitted)',
          '--user <user_id>              User to explain (mutually exclusive with --service-principal/--group)',
          '--service-principal <sp_id>   Service principal to explain (mutually exclusive with --user/--group)',
          '--group <group_id>            Group to explain directly (mutually exclusive with --user/--service-principal)',
          '--permission <perm>           Permission to explain (e.g., chat:write, jobs:admin)',
          '--project <project_id>        Optional project scope for the explanation',
          '--resource-type <type>        Optional resource type: orgfs|orgdocs|envdb',
          '--resource <id>               Optional resource id/path (required when --resource-type used)',
          '--action <action>             Optional action: read|write|admin',
        ],
        examples: [
          'eve access explain --org org_xxx --user user_abc --permission jobs:admin',
          'eve access explain --org org_xxx --user user_abc --project proj_xxx --permission jobs:admin',
          'eve access explain --org org_xxx --service-principal sp_xxx --permission jobs:read',
          'eve access explain --org org_xxx --user user_abc --permission orgfs:read --resource-type orgfs --resource /groups/pm/spec.md --action read',
        ],
      },
      groups: {
        description: 'Manage access groups and members',
        usage: 'eve access groups <create|list|show|update|delete|members> [args]',
        examples: [
          'eve access groups create "Product Management" --org org_xxx --slug pm-team',
          'eve access groups list --org org_xxx',
          'eve access groups members add pm-team --org org_xxx --user user_abc',
          'eve access groups members list pm-team --org org_xxx',
        ],
      },
      memberships: {
        description: 'Inspect memberships, effective bindings, and effective scopes for a principal',
        usage: 'eve access memberships --org <org_id> (--user <id>|--service-principal <id>|--group <id>)',
        examples: [
          'eve access memberships --org org_xxx --user user_abc',
          'eve access memberships --org org_xxx --service-principal sp_abc',
          'eve access memberships --org org_xxx --group grp_abc',
        ],
      },
      validate: {
        description: 'Validate an .eve/access.yaml file (schema + semantic checks)',
        usage: 'eve access validate [--file <path>] [--json]',
        options: [
          '--file <path>      Path to access YAML file (default: .eve/access.yaml)',
          '--json              Output validation result as JSON',
        ],
        examples: [
          'eve access validate',
          'eve access validate --file custom/access.yaml',
          'eve access validate --json',
        ],
      },
      plan: {
        description: 'Show changes needed to sync access.yaml to an org (dry run)',
        usage: 'eve access plan [--file <path>] --org <org_id> [--json]',
        options: [
          '--file <path>      Path to access YAML file (default: .eve/access.yaml)',
          '--org <org_id>      Org to plan against (uses profile default if omitted)',
          '--json              Output plan as machine-readable JSON',
        ],
        examples: [
          'eve access plan --org org_xxx',
          'eve access plan --file .eve/access.yaml --org org_xxx --json',
        ],
      },
      sync: {
        description: 'Apply access.yaml to an org (create/update roles and bindings)',
        usage: 'eve access sync [--file <path>] --org <org_id> [--yes] [--prune] [--json]',
        options: [
          '--file <path>      Path to access YAML file (default: .eve/access.yaml)',
          '--org <org_id>      Org to sync to (uses profile default if omitted)',
          '--yes               Skip confirmation prompt',
          '--prune             Delete roles/bindings that exist in the org but not in the YAML',
          '--json              Output sync result as JSON',
        ],
        examples: [
          'eve access sync --org org_xxx',
          'eve access sync --org org_xxx --yes',
          'eve access sync --org org_xxx --prune --yes',
          'eve access sync --file .eve/access.yaml --org org_xxx --json',
        ],
      },
    },
  },

  env: {
    description: 'Manage environments for projects. Environments are deployment targets (staging, production, test).',
    usage: 'eve env <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List environments for a project',
        usage: 'eve env list [project]',
        options: [
          '<project>             Project ID or slug (uses profile default if omitted)',
        ],
        examples: ['eve env list', 'eve env list proj_xxx'],
      },
      show: {
        description: 'Show details of an environment',
        usage: 'eve env show <project> <name>',
        examples: ['eve env show proj_xxx staging', 'eve env show my-project production'],
      },
      create: {
        description: 'Create an environment',
        usage: 'eve env create <name> --type=<type> [options]',
        options: [
          '<name>                Environment name (e.g., staging, production, test)',
          '--type <type>         Environment type: persistent or temporary (required)',
          '--namespace <ns>      K8s namespace (optional)',
          '--db-ref <ref>        Database reference (optional)',
          '--project <id>        Project ID (uses profile default if omitted)',
        ],
        examples: [
          'eve env create staging --type=persistent',
          'eve env create test --type=persistent --namespace=eve-test',
        ],
      },
      deploy: {
        description: 'Deploy to an environment',
        usage: 'eve env deploy <env> (--ref <sha>|--release-tag <tag>) [--direct] [--inputs <json>] [--image-tag <tag>] [--repo-dir <path>] [--skip-preflight] [--project <id>]',
        options: [
          '<env>                  Environment name (staging, production, test)',
          '--ref <sha>            Git SHA (choose one: --ref or --release-tag)',
          '--release-tag <tag>    Deploy an existing release by tag (choose one: --ref or --release-tag)',
          '--direct               Bypass pipeline and do direct deploy',
          '--inputs <json>        JSON inputs for the deployment (e.g., \'{"release_id":"rel_xxx"}\')',
          '--image-tag <tag>      Use a specific image tag for deploy (direct only)',
          '--repo-dir <path>      Resolve --ref against this repo instead of cwd',
          '--skip-preflight       Skip deploy image preflight checks',
          '--project <id>         Project ID or slug (uses profile default if omitted)',
          '--watch                Poll deployment status until ready (default: true)',
          '--timeout <seconds>    Watch timeout in seconds (default: 120)',
        ],
        examples: [
          'eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567',
          'eve env deploy staging --release-tag v1.2.3',
          'eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --direct',
          'eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --inputs \'{"release_id":"rel_xxx","smoke_test":false}\'',
          'eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --direct --inputs \'{"release_id":"rel_xxx"}\'',
          'eve env deploy staging --ref main --repo-dir ./my-app',
        ],
      },
      rollback: {
        description: 'Roll back an environment to a known release',
        usage: 'eve env rollback <env> --release <id|tag|previous> [--project <id>] [--skip-preflight]',
        options: [
          '<env>                  Environment name',
          '--release <ref>        Release ID, release tag, or "previous"',
          '--project <id>         Project ID (uses profile default if omitted)',
          '--skip-preflight       Skip deploy image preflight checks',
        ],
        examples: [
          'eve env rollback staging --release previous',
          'eve env rollback staging --release rel_xxx --project proj_xxx',
        ],
      },
      reset: {
        description: 'Reset an environment (cancel runs, teardown workloads, redeploy release)',
        usage: 'eve env reset <env> [--release <id|tag|previous>] [--project <id>] [--force] [--danger-reset-production] [--skip-preflight]',
        options: [
          '<env>                  Environment name',
          '--release <ref>        Optional release override; defaults to current release pointer',
          '--project <id>         Project ID (uses profile default if omitted)',
          '--force                Required for non-production persistent envs',
          '--danger-reset-production Required for production envs',
          '--skip-preflight       Skip deploy image preflight checks',
        ],
        examples: [
          'eve env reset staging --force',
          'eve env reset production --danger-reset-production --release v1.2.3',
        ],
      },
      recover: {
        description: 'Analyze environment issues and suggest the next recovery command',
        usage: 'eve env recover <project> <env>',
        examples: ['eve env recover proj_xxx staging'],
      },
      diagnose: {
        description: 'Diagnose environment deployments (k8s-only)',
        usage: 'eve env diagnose <project> <env> [--events <n>] [--request <id>] [--window <seconds>]',
        options: [
          '<project>             Project ID or slug',
          '<env>                 Environment name',
          '--events <n>          Limit number of recent events',
          '--request <id>        Diagnose one request ID across logs, events, deploy metadata, and traces',
          '--window <seconds>    Request lookup window in seconds (default 60, max 600)',
        ],
        examples: [
          'eve env diagnose proj_xxx staging',
          'eve env diagnose proj_xxx staging --events 20',
          'eve env diagnose proj_xxx staging --request req_01h... --json',
        ],
      },
      services: {
        description: 'Show per-service pod status summary (k8s-only)',
        usage: 'eve env services <project> <env>',
        options: [
          '<project>             Project ID or slug',
          '<env>                 Environment name',
        ],
        examples: [
          'eve env services proj_xxx staging',
        ],
      },
      logs: {
        description: 'Fetch logs for a service in an environment (k8s-only)',
        usage: 'eve env logs <project> <env> <service> [--follow] [--since <seconds>] [--tail <n>] [--grep <text>] [--filter k=v] [--pod <name>] [--container <name>] [--previous] [--all-pods]',
        options: [
          '<project>             Project ID or slug',
          '<env>                 Environment name (staging, production, test)',
          '<service>             Service name from manifest',
          '--follow, -f          Stream logs until interrupted',
          '--since <seconds>     Seconds since now (optional)',
          '--tail <n>            Tail line count (optional)',
          '--grep <text>         Filter lines containing text (optional)',
          '--filter k=v          Repeatable JSON field filter; dotted paths supported; numeric/boolean coercion',
          '--pod <name>          Specific pod name (optional)',
          '--container <name>    Specific container name (optional)',
          '--previous            Use previous container logs (optional)',
          '--all-pods            Fetch logs for all matching pods (optional)',
        ],
        examples: [
          'eve env logs proj_xxx staging api --tail 200',
          'eve env logs proj_xxx staging api --since 3600 --grep ERROR',
          'eve env logs proj_xxx staging api --filter req_id=req_01h... --filter level=error',
          'eve env logs proj_xxx staging api --follow --since 30',
          'eve env logs proj_xxx staging api --all-pods',
        ],
      },
      delete: {
        description: 'Delete an environment',
        usage: 'eve env delete <name> [--project=<id>] [--force] [--danger-delete-production]',
        options: [
          '<name>                Environment name to delete',
          '--project <id>        Project ID (uses profile default if omitted)',
          '--force               Skip confirmation prompt',
          '--danger-delete-production Required for production envs',
        ],
        examples: [
          'eve env delete test',
          'eve env delete staging --project=proj_xxx',
          'eve env delete old-env --force',
        ],
      },
    },
    examples: [
      'eve env list',
      'eve env create test --type=persistent',
      'eve env deploy staging --ref abc123',
      'eve env logs proj_xxx staging api --tail 200',
      'eve env diagnose proj_xxx staging',
      'eve env services proj_xxx staging',
    ],
  },

  traces: {
    description: 'Query project traces from the configured trace backend.',
    usage: 'eve traces query [options]',
    subcommands: {
      query: {
        description: 'Query traces by request ID, trace ID, route, error, or time window',
        usage: 'eve traces query [--project <id>] [--service <name>] (--request-id <id>|--trace-id <id>|--since <duration>|--error|--route <route>) [--json]',
        options: [
          '--project <id>       Project ID (uses profile default if omitted)',
          '--service <name>     Service name from manifest',
          '--request-id <id>    Request ID annotation to query',
          '--trace-id <id>      Exact trace ID',
          '--since <duration>   Window such as 5m, 1h, or seconds',
          '--error              Only error traces',
          '--route <route>      Route annotation, for example "POST /api/cameras"',
          '--p99                Compute p99 duration over the returned summaries',
          '--limit <n>          Max trace summaries to fetch (default 100, max 1000)',
          '--no-cache           Bypass the API 30s query cache',
          '--json               Emit structured JSON',
        ],
        examples: [
          'eve traces query --project proj_xxx --service api --request-id req_01h... --json',
          'eve traces query --project proj_xxx --trace-id 1-abcdef...',
          'eve traces query --project proj_xxx --service api --since 5m --error',
        ],
      },
    },
  },

  api: {
    description: 'Explore project API sources and call them with Eve auth.',
    usage: 'eve api <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List API sources for a project',
        usage: 'eve api list [project] [--env <name>]',
        options: [
          '<project>             Project ID (uses profile default if omitted)',
          '--env <name>          Environment name (optional filter)',
        ],
        examples: ['eve api list', 'eve api list proj_xxx --env staging'],
      },
      show: {
        description: 'Show details for a single API source',
        usage: 'eve api show <name> [project]',
        options: ['--env <name>          Environment name (optional filter)'],
        examples: ['eve api show app', 'eve api show app proj_xxx --env staging'],
      },
      spec: {
        description: 'Show cached API spec (OpenAPI/GraphQL)',
        usage: 'eve api spec <name> [project]',
        options: ['--env <name>          Environment name (optional filter)'],
        examples: ['eve api spec app', 'eve api spec app proj_xxx --env staging'],
      },
      refresh: {
        description: 'Refresh cached API spec',
        usage: 'eve api refresh <name> [project]',
        options: ['--env <name>          Environment name (optional filter)'],
        examples: ['eve api refresh app --env staging'],
      },
      examples: {
        description: 'Print curl templates from the cached API spec',
        usage: 'eve api examples <name> [project]',
        options: ['--env <name>          Environment name (optional filter)'],
        examples: ['eve api examples app', 'eve api examples app --env staging'],
      },
      call: {
        description: 'Call an API endpoint with Eve auth',
        usage: 'eve api call <name> <method> <path> [options]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--env <name>         Environment name (optional source)',
          '--json <payload>     JSON body inline or @file',
          '--data <payload>     Alias for --json (curl-style)',
          '-d <payload>         Shorthand alias for --json',
          '--jq <expr>          Filter JSON output with jq',
          '--graphql <query>    GraphQL query inline or @file',
          '--variables <json>   JSON variables for GraphQL query',
          '--token <token>      Override auth token',
          '--print-curl         Print curl command instead of executing',
        ],
        examples: [
          'eve api call app GET /notes --jq ".items"',
          'eve api call app POST /notes --json "{\"title\":\"Hello\"}"',
          'eve api call app POST /notes --data "{\"title\":\"Hello\"}"',
          'eve api call graphql POST /graphql --graphql "{ notes { id } }"',
        ],
      },
      generate: {
        description: 'Export the API OpenAPI spec from the server',
        usage: 'eve api generate [--out <dir>]',
        options: ['--out <dir>          Output directory (default: docs/system)'],
        examples: ['eve api generate', 'eve api generate --out ./tmp/openapi'],
      },
      diff: {
        description: 'Diff generated OpenAPI spec against the repo copy',
        usage: 'eve api diff [--exit-code] [--out <dir>]',
        options: [
          '--exit-code         Exit non-zero when drift detected',
          '--out <dir>         Directory containing expected spec (default: docs/system)',
        ],
        examples: ['eve api diff --exit-code'],
      },
    },
  },

  db: {
    description: 'Inspect and query environment databases with Eve auth + RLS.',
    usage: 'eve db <subcommand> [options]',
    subcommands: {
      schema: {
        description: 'Show database schema for an environment',
        usage: 'eve db schema --env <name>|--url <postgres-url> [--project <id>]',
        options: ['--env <name>          Environment name', '--url <postgres-url> Direct Postgres connection'],
        examples: ['eve db schema --env staging', 'eve db schema --url postgres://app:secret@localhost:5432/myapp'],
      },
      rls: {
        description: 'Show RLS policies or scaffold helper SQL',
        usage: 'eve db rls --env <name> [--project <id>] | eve db rls init --with-groups [--out <path>] [--force]',
        options: [
          '--env <name>          Environment name (required for inspect mode)',
          '--with-groups         Generate app.current_group_ids()/app.has_group() helper SQL (init mode)',
          '--out <path>          Output file for init mode (default: db/rls/helpers.sql)',
          '--force               Overwrite output file when it already exists',
        ],
        examples: ['eve db rls --env staging', 'eve db rls init --with-groups'],
      },
      extensions: {
        description: 'List installed Postgres extensions for an environment database',
        usage: 'eve db extensions list --env <name> [--project <id>]',
        options: [
          '--env <name>          Environment name',
          '--project <id>       Project ID (uses profile default)',
          '--json               Machine-readable JSON output',
        ],
        examples: ['eve db extensions list --env staging', 'eve db extensions list --env staging --json'],
      },
      sql: {
        description: 'Run parameterized SQL as the calling user',
        usage: 'eve db sql --env <name>|--url <postgres-url> --sql <statement> [options]',
        options: [
          '--env <name>          Environment name',
          '--url <postgres-url>  Direct Postgres connection',
          '--sql <statement>     SQL to run (inline)',
          '--file <path>         Read SQL from file',
          '--params <json>       JSON array/object of parameters',
          '--write               Allow writes (requires db.write scope)',
        ],
        examples: [
          'eve db sql --env staging --sql "select * from notes"',
          'eve db sql --url postgres://app:secret@localhost:5432/myapp --sql "select 1"',
          'eve db sql --env staging --file ./query.sql --params "[1]"',
        ],
      },
      migrate: {
        description: 'Apply pending migrations',
        usage: 'eve db migrate --env <name>|--url <postgres-url> [--path db/migrations] [--project <id>]',
        examples: [
          'eve db migrate --env staging',
          'eve db migrate --url postgres://app:secret@localhost:5432/myapp',
        ],
      },
      migrations: {
        description: 'List applied migrations',
        usage: 'eve db migrations --env <name>|--url <postgres-url> [--project <id>]',
      },
      reset: {
        description: 'Reset schema and optionally re-apply migrations',
        usage: 'eve db reset --env <name>|--url <postgres-url> --force [--no-migrate] [--project <id>]',
      },
      wipe: {
        description: 'Alias for reset with --no-migrate',
        usage: 'eve db wipe --env <name>|--url <postgres-url> --force [--project <id>]',
      },
    },
  },

  pipeline: {
    description: 'Run and inspect pipelines defined in the project manifest.',
    usage: 'eve pipeline <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List pipelines for a project',
        usage: 'eve pipeline list [project]',
        options: [
          '<project>             Project ID or slug (uses profile default if omitted)',
        ],
        examples: ['eve pipeline list', 'eve pipeline list proj_xxx'],
      },
      show: {
        description: 'Show pipeline definition',
        usage: 'eve pipeline show <project> <name>',
        examples: ['eve pipeline show proj_xxx release', 'eve pipeline show my-project deploy'],
      },
      run: {
        description: 'Run a pipeline',
        usage: 'eve pipeline run <name> --ref <sha> [--env <env>] [--repo-dir <path>] [--wait] [--only <step>]',
        options: [
          '--ref <sha>          Git SHA (required). Non-SHA refs resolve against the repo in --repo-dir or cwd.',
          '--env <env>          Target environment',
          '--project <id>       Project ID (uses profile default)',
          '--wait               Wait for completion',
          '--timeout <n>        Max wait time (seconds)',
          '--inputs <json>      JSON inputs for the pipeline',
          '--only <step>        Run a single step (includes dependencies)',
          '--repo-dir <path>    Resolve --ref against this repo instead of cwd',
        ],
        examples: [
          'eve pipeline run deploy-test --ref 0123456789abcdef0123456789abcdef01234567 --env test',
          'eve pipeline run deploy-test --ref 0123456789abcdef0123456789abcdef01234567 --env test --wait --timeout 120',
          'eve pipeline run deploy-test --ref main --repo-dir ./my-app --env test',
        ],
      },
      runs: {
        description: 'List runs for a pipeline',
        usage: 'eve pipeline runs <name> [project]',
        options: [
          '--limit <n>          Number of results (default: 10)',
          '--offset <n>         Skip first n results',
        ],
        examples: ['eve pipeline runs deploy-test', 'eve pipeline runs deploy-test proj_xxx'],
      },
      'show-run': {
        description: 'Show a pipeline run',
        usage: 'eve pipeline show-run <name> <run-id> [--project <id>]',
        examples: ['eve pipeline show-run deploy-test prun_xxx'],
      },
      approve: {
        description: 'Approve a pipeline run awaiting approval',
        usage: 'eve pipeline approve <run-id>',
        examples: ['eve pipeline approve prun_xxx'],
      },
      cancel: {
        description: 'Cancel a pipeline run',
        usage: 'eve pipeline cancel <run-id> [--reason <text>]',
        examples: ['eve pipeline cancel prun_xxx --reason "superseded"'],
      },
      logs: {
        description: 'Show logs for a pipeline run',
        usage: 'eve pipeline logs <pipeline> <run-id> [--step <name>] [--follow]',
        options: [
          '--step <name>        Show logs for a specific step only',
          '--follow (-f)        Stream live logs via SSE',
          '--project <id>       Project ID (uses profile default)',
        ],
        examples: [
          'eve pipeline logs deploy-test prun_xxx',
          'eve pipeline logs deploy-test prun_xxx --step build',
          'eve pipeline logs deploy-test prun_xxx --follow',
        ],
      },
    },
    examples: ['eve pipeline list', 'eve pipeline run deploy-test --ref 0123456789abcdef0123456789abcdef01234567 --env test', 'eve pipeline logs deploy-test prun_xxx --follow'],
  },

  workflow: {
    description: 'Inspect and invoke workflows defined in the project manifest.',
    usage: 'eve workflow <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List workflows for a project',
        usage: 'eve workflow list [project]',
        options: [
          '<project>             Project ID or slug (uses profile default if omitted)',
        ],
        examples: ['eve workflow list', 'eve workflow list proj_xxx'],
      },
      show: {
        description: 'Show workflow definition',
        usage: 'eve workflow show <project> <name>',
        examples: ['eve workflow show proj_xxx qa-review', 'eve workflow show my-project release-notes'],
      },
      run: {
        description: 'Invoke a workflow (fire-and-forget)',
        usage: 'eve workflow run [project] <workflow-name> [--input <json>] [--env-override KEY=VALUE]',
        options: [
          '--input <json>        Input payload (JSON string)',
          '--env-override KEY=VALUE Invocation env override; repeatable',
          '--project <id>        Project ID (uses profile default)',
        ],
        examples: [
          'eve workflow run qa-review --input "{\"task\":\"audit\"}"',
          'eve workflow run qa-review --env-override WEB_SEARCH_API_KEY=${secret.WEB_SEARCH_API_KEY}',
          'eve workflow run proj_xxx release-notes --input "{\"tag\":\"v1.2.3\"}"',
        ],
      },
      invoke: {
        description: 'Invoke a workflow and wait for result',
        usage: 'eve workflow invoke [project] <workflow-name> [--input <json>] [--env-override KEY=VALUE] [--no-wait]',
        options: [
          '--input <json>        Input payload (JSON string)',
          '--env-override KEY=VALUE Invocation env override; repeatable',
          '--no-wait             Return immediately without waiting',
          '--project <id>        Project ID (uses profile default)',
        ],
        examples: [
          'eve workflow invoke qa-review --input "{\"task\":\"audit\"}"',
          'eve workflow invoke qa-review --env-override WEB_SEARCH_API_KEY=${secret.WEB_SEARCH_API_KEY}',
          'eve workflow invoke proj_xxx release-notes --no-wait',
        ],
      },
      retry: {
        description: 'Retry failed workflow steps without rerunning successful predecessors',
        usage: 'eve workflow retry <root-job-id> (--failed | --from <step>) [--project <id>]',
        options: [
          '--failed              Retry failed/upstream-failed current steps',
          '--from <step>         Retry a named step and its downstream dependents',
          '--project <id>        Project ID (uses profile default, or resolves from job)',
          '--json                Print machine-readable response',
        ],
        examples: [
          'eve workflow retry acme-fd842fff --failed',
          'eve workflow retry acme-fd842fff --from review',
        ],
      },
      logs: {
        description: 'Show logs for a workflow job',
        usage: 'eve workflow logs <job-id>',
        examples: ['eve workflow logs job_abc123'],
      },
    },
    examples: [
      'eve workflow list',
      'eve workflow show proj_xxx qa-review',
      'eve workflow run qa-review --input "{\"task\":\"audit\"}"',
      'eve workflow retry acme-fd842fff --failed',
    ],
  },

  event: {
    description: 'Emit and inspect events. Apps use this to participate in the Event Ecosystem.',
    usage: 'eve event <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List events for a project',
        usage: 'eve event list [project] [--type] [--source] [--status]',
        options: [
          '<project>             Project ID or slug (uses profile default if omitted)',
          '--type <type>         Filter by event type (e.g., github.push, app.deploy.complete)',
          '--source <source>     Filter by source (e.g., github, cron, app)',
          '--status <status>     Filter by status (pending, processed, failed)',
          '--limit <n>           Number of results',
          '--offset <n>          Skip first n results',
        ],
        examples: ['eve event list', 'eve event list --type app.deploy.complete --source app'],
      },
      show: {
        description: 'Show event details',
        usage: 'eve event show <event_id> [--project <id>]',
        examples: ['eve event show evt_xxx', 'eve event show evt_xxx --project proj_yyy'],
      },
      emit: {
        description: 'Emit an event to trigger pipelines or notify other services',
        usage: 'eve event emit --type <type> --source <source> [options]',
        options: [
          '--project <id>        Project ID (required)',
          '--type <type>         Event type (e.g., app.build.complete, deploy.finished)',
          '--source <source>     Event source (e.g., app, ci, manual)',
          '--env <name>          Environment name',
          '--branch <branch>     Git branch reference',
          '--sha <sha>           Git commit SHA',
          '--payload <json>      JSON payload with event data',
        ],
        examples: [
          'eve event emit --project proj_xxx --type app.build.complete --source app',
          'eve event emit --project proj_xxx --type deploy.finished --source ci --env production --payload \'{"version":"1.2.3"}\'',
        ],
      },
    },
    examples: [
      'eve event list',
      'eve event emit --type app.ready --source app --project proj_xxx',
    ],
  },

  packs: {
    description: 'Manage AgentPack lockfile and resolution.',
    usage: 'eve packs <subcommand> [options]',
    subcommands: {
      status: {
        description: 'Show resolved packs from lockfile, effective config stats, and drift detection',
        usage: 'eve packs status [--path <dir>]',
        options: [
          '--path <dir>        Repository root to inspect (default: cwd)',
        ],
        examples: [
          'eve packs status',
          'eve packs status --path ../my-repo',
        ],
      },
      resolve: {
        description: 'Resolve packs and merge configs (delegates to project sync)',
        usage: 'eve packs resolve [--dry-run]',
        options: [
          '--dry-run            Preview resolution without writing lockfile',
          '--path <dir>         Repository root to inspect (default: cwd)',
        ],
        examples: [
          'eve packs resolve --dry-run',
          'eve packs resolve',
        ],
      },
    },
    examples: [
      'eve packs status',
      'eve packs resolve --dry-run',
    ],
  },

  skills: {
    description: 'Install developer skills or materialize runtime skills.',
    usage: 'eve skills <subcommand> [source]',
    subcommands: {
      install: {
        description: 'Install developer skill packs from a source or skills.txt manifest',
        usage: 'eve skills install [source] [--skip-installed]',
        options: [
          '[source]          URL, GitHub repo (owner/repo), or local path',
          '--skip-installed  Skip skills that are already installed',
        ],
        examples: [
          'eve skills install https://github.com/org/skillpack',
          'eve skills install org/skillpack',
          'eve skills install ./local/skills',
          'eve skills install',
          'eve skills install --skip-installed',
        ],
      },
      materialize: {
        description: 'Materialize runtime skills directly into the workspace without skills add subprocesses',
        usage: 'eve skills materialize <manifest|skills.txt> [--skill-mode <name>] [--mode symlink|copy] [--agents a,b]',
        options: [
          '<manifest|skills.txt>  Materialize manifest runtime skills or local skills.txt sources',
          '--skill-mode <name>    Manifest skill mode to resolve (default: runtime)',
          '--mode <kind>          Filesystem mode: symlink or copy (default: symlink)',
          '--agents <list>        Comma-separated agent override',
          '--runtime              Runtime-only mode: consume vendored external skills without fetching',
        ],
        examples: [
          'eve skills materialize manifest',
          'eve skills materialize manifest --skill-mode software-engineering',
          'eve skills materialize skills.txt',
          'eve skills materialize manifest --runtime',
        ],
      },
    },
    examples: [
      'eve skills install https://github.com/org/skillpack',
      'eve skills install org/skillpack',
      'eve skills install',
      'eve skills materialize manifest',
    ],
  },

  user: {
    description: 'Look up user profiles and memberships.',
    usage: 'eve user <subcommand> [options]',
    subcommands: {
      show: {
        description: 'Show user profile with org and project memberships',
        usage: 'eve user show [user_id|me]',
        options: [
          '--json    Output as JSON',
        ],
        examples: [
          'eve user show me',
          'eve user show usr_abc123',
          'eve user show me --json',
        ],
      },
    },
  },
  admin: {
    description: 'Administrative commands for user, identity, and platform operations.',
    usage: 'eve admin <subcommand> [options]',
    subcommands: {
      invite: {
        description: 'Invite a user by registering their SSH keys (from GitHub or a local file) and adding them to an org',
        usage: 'eve admin invite --email <email> [--github <username>] [--ssh-key <path>] [--role <role>] [--org <org_id>] [--web] [--redirect-to <url>]',
        options: [
          '--email <email>       User email address (required)',
          '--github <username>   GitHub username to fetch SSH keys from',
          '--ssh-key <path>      Path to an SSH public key file to register',
          '--role <role>         Org role: owner, admin, member (default: member)',
          '--org <org_id>        Organization to add user to',
          '--web                 Send a Supabase Auth invite email',
          '--redirect-to <url>   Redirect URL after web login',
          '',
          'At least one auth method (--github, --ssh-key, or --web) is recommended.',
          'Users can also self-register: eve auth request-access --org "Org" --ssh-key ~/.ssh/id_ed25519.pub --wait',
        ],
        examples: [
          'eve admin invite --email user@example.com --github octocat',
          'eve admin invite --email user@example.com --ssh-key ~/.ssh/id_ed25519.pub --org org_xxx',
          'eve admin invite --email user@example.com --github octocat --role admin --org org_xxx',
          'eve admin invite --email user@example.com --web --redirect-to https://app.example.com',
        ],
      },
      'access-requests': {
        description: 'Review, approve, or reject self-service access requests',
        usage: 'eve admin access-requests [approve|reject <id>] [--reason "..."]',
        options: [
          '(no action)          List pending access requests',
          'approve <id>         Approve a request (creates user, org membership, and identity)',
          'reject <id>          Reject a request',
          '--reason "<text>"    Note to attach to approval/rejection',
        ],
        examples: [
          'eve admin access-requests',
          'eve admin access-requests approve ar_xxx',
          'eve admin access-requests reject ar_xxx --reason "Unknown user"',
        ],
      },
      'ingress-aliases': {
        description: 'Inspect and reclaim ingress alias claims (system admin)',
        usage: 'eve admin ingress-aliases <list|reclaim> [options]',
        options: [
          'list options: --alias <name> --project <id> --environment <id|null> --limit <n> --offset <n>',
          'reclaim usage: eve admin ingress-aliases reclaim <alias> --reason "<text>"',
        ],
        examples: [
          'eve admin ingress-aliases list --project proj_xxx',
          'eve admin ingress-aliases reclaim eve-pm --reason "Reserved org rename"',
        ],
      },
    },
    examples: [
      'eve admin invite --email user@example.com --github octocat',
      'eve admin invite --email user@example.com --ssh-key ~/.ssh/id_ed25519.pub --org org_xxx',
      'eve admin access-requests',
      'eve admin access-requests approve ar_xxx',
      'eve admin ingress-aliases list',
    ],
  },

  release: {
    description: 'Manage and inspect releases.',
    usage: 'eve release <subcommand> [options]',
    subcommands: {
      resolve: {
        description: 'Look up a release by tag and output its details',
        usage: 'eve release resolve <tag> [--project <id>]',
        options: [
          '<tag>                Release tag (e.g., v1.2.3)',
          '--project <id>       Project ID (uses profile default or .eve/manifest.yaml if omitted)',
          '--json               Output as JSON',
        ],
        examples: [
          'eve release resolve v1.2.3',
          'eve release resolve v1.2.3 --project proj_xxx',
          'eve release resolve v1.2.3 --json',
        ],
      },
    },
    examples: [
      'eve release resolve v1.2.3',
      'eve release resolve v1.2.3 --json',
    ],
  },

  build: {
    description: 'Manage builds. Builds are first-class primitives for container image creation (specs, runs, artifacts).',
    usage: 'eve build <subcommand> [options]',
    subcommands: {
      create: {
        description: 'Create a new build spec',
        usage: 'eve build create --project <id> --ref <sha> --manifest-hash <hash> [--services <s1,s2>] [--repo-dir <path>]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--ref <sha>          Git SHA (required). Non-SHA refs resolve against the repo in --repo-dir or cwd.',
          '--manifest-hash <h>  Manifest hash (required)',
          '--services <list>    Comma-separated service names to build',
          '--repo-dir <path>    Resolve --ref against this repo instead of cwd',
        ],
        examples: [
          'eve build create --ref 0123456789abcdef0123456789abcdef01234567 --manifest-hash mfst_123',
          'eve build create --project proj_xxx --ref 0123456789abcdef0123456789abcdef01234567 --manifest-hash mfst_123 --services api,web',
          'eve build create --project proj_xxx --ref main --repo-dir ./my-app --manifest-hash mfst_123',
        ],
      },
      list: {
        description: 'List build specs for a project',
        usage: 'eve build list [--project <id>] [--limit <n>] [--offset <n>]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--limit <n>          Number of results',
          '--offset <n>         Skip first n results',
        ],
        examples: [
          'eve build list',
          'eve build list --project proj_xxx --limit 20',
        ],
      },
      show: {
        description: 'Show build spec details',
        usage: 'eve build show <build_id>',
        examples: [
          'eve build show build_xxx',
        ],
      },
      run: {
        description: 'Start a build run for an existing build spec',
        usage: 'eve build run <build_id>',
        examples: [
          'eve build run build_xxx',
        ],
      },
      runs: {
        description: 'List runs for a build spec',
        usage: 'eve build runs <build_id> [--limit <n>]',
        options: [
          '--limit <n>          Number of results',
          '--offset <n>         Skip first n results',
        ],
        examples: [
          'eve build runs build_xxx',
        ],
      },
      logs: {
        description: 'Show build logs',
        usage: 'eve build logs <build_id> [--run <run_id>]',
        options: [
          '--run <id>           Specific run ID (default: latest)',
        ],
        examples: [
          'eve build logs build_xxx',
          'eve build logs build_xxx --run brun_yyy',
        ],
      },
      artifacts: {
        description: 'List build artifacts (images produced)',
        usage: 'eve build artifacts <build_id>',
        examples: [
          'eve build artifacts build_xxx',
        ],
      },
      diagnose: {
        description: 'Show full build state (spec, runs, artifacts, logs)',
        usage: 'eve build diagnose <build_id>',
        examples: [
          'eve build diagnose build_xxx',
        ],
      },
      cancel: {
        description: 'Cancel an active build run',
        usage: 'eve build cancel <build_id>',
        examples: [
          'eve build cancel build_xxx',
        ],
      },
    },
    examples: [
      'eve build create --ref 0123456789abcdef0123456789abcdef01234567 --manifest-hash mfst_123 --services api,web',
      'eve build list',
      'eve build show build_xxx',
      'eve build run build_xxx',
      'eve build logs build_xxx',
      'eve build artifacts build_xxx',
      'eve build diagnose build_xxx',
    ],
  },

  init: {
    description: `Initialize a new Eve Horizon project from a template.

Downloads the starter template, strips git history, initializes a fresh repo,
and installs skills. After init, start your AI coding agent and run the
eve-new-project-setup skill to complete configuration.`,
    usage: 'eve init [directory] [--template <url>] [--branch <branch>]',
    subcommands: {
      '': {
        description: 'Initialize project in current or specified directory',
        usage: 'eve init [directory] [options]',
        options: [
          '[directory]           Target directory (default: current directory)',
          '--template <url>      Template repository URL',
          '                      (default: https://github.com/eve-horizon/eve-horizon-starter)',
          '--branch <branch>     Branch to use (default: main)',
          '--skip-skills         Skip automatic skill installation',
        ],
        examples: [
          'eve init',
          'eve init my-project',
          'eve init my-project --template https://github.com/myorg/my-template',
          'eve init . --branch develop',
        ],
      },
    },
    examples: [
      'eve init my-project',
      'eve init',
      'eve init my-app --template https://github.com/myorg/custom-starter',
    ],
  },

  local: {
    description: `Local development environment management.

Manages a local k3d Kubernetes cluster running the Eve platform.
Requires Docker Desktop; k3d and kubectl are auto-managed by the CLI.`,
    usage: 'eve local <up|down|status|reset|logs|health|mesh> [options]',
    subcommands: {
      up: {
        description: 'Create/prepare local cluster and deploy Eve services',
        usage: 'eve local up [--skip-deploy] [--skip-health] [--timeout <seconds>] [--version <tag>] [--verbose]',
        options: [
          '--skip-deploy       Create cluster only, skip deploy step',
          '--skip-health       Skip waiting for API health',
          '--timeout <sec>     Health wait timeout in seconds (default: 300)',
          '--version <tag>     Platform image version (default: latest)',
          '--verbose           Print detailed command output',
        ],
        examples: [
          'eve local up',
          'eve local up --version 0.1.70',
          'eve local up --skip-deploy',
          'eve local up --timeout 600',
        ],
      },
      down: {
        description: 'Stop local stack resources, or destroy cluster entirely',
        usage: 'eve local down [--destroy] [--force]',
        options: [
          '--destroy           Delete k3d cluster and persistent data',
          '--force             Skip confirmation prompts',
        ],
        examples: [
          'eve local down',
          'eve local down --destroy --force',
        ],
      },
      status: {
        description: 'Show cluster state, service readiness, and URLs',
        usage: 'eve local status [--watch] [--json]',
        options: [
          '--watch             Refresh every 5 seconds',
          '--json              Machine-readable JSON output',
        ],
        examples: [
          'eve local status',
          'eve local status --watch',
          'eve local status --json',
        ],
      },
      reset: {
        description: 'Destroy and recreate local stack',
        usage: 'eve local reset [--force]',
        options: [
          '--force             Skip confirmation prompts',
        ],
        examples: [
          'eve local reset --force',
        ],
      },
      logs: {
        description: 'Stream or dump logs from local stack services',
        usage: 'eve local logs [service] [--follow] [--tail <n>] [--since <duration>]',
        options: [
          '[service]           api|orchestrator|worker|gateway|agent-runtime|auth|postgres|mailpit|sso',
          '--follow            Follow logs in real time',
          '--tail <n>          Show last n lines (default: 50)',
          '--since <duration>  Show logs since duration (for example: 5m, 1h)',
        ],
        examples: [
          'eve local logs',
          'eve local logs api --follow',
          'eve local logs worker --tail 200',
        ],
      },
      health: {
        description: 'Quick health check (exit code 0 when healthy)',
        usage: 'eve local health [--json]',
        examples: [
          'eve local health',
          'eve local health --json',
        ],
      },
      mesh: {
        description: 'Run a multi-project app-link mesh on the local k3d stack',
        usage: 'eve local mesh <init|add|use|list|show|up|down|redeploy|status|logs|diagnose> [options]',
        options: [
          '--workspace <name|path> Select workspace (defaults to ~/.eve/active-workspace)',
          '--only <project>        Limit up to one project plus upstream producers',
          '--skip-pre-check        Skip API/auth health checks before up',
          '--skip-cli-build        Do not build/import producer CLI images',
          '--probe                 For diagnose, run in-cluster reachability probes',
          '--json                  Machine-readable JSON output',
        ],
        examples: [
          'eve local mesh init obs --org org_manualtestorg --env local',
          'eve local mesh add prod --path ../producer',
          'eve local mesh add cons --path ../consumer',
          'eve local mesh up',
          'eve local mesh redeploy cons',
          'eve local mesh diagnose --probe',
        ],
      },
    },
    examples: [
      'eve local up',
      'eve local status --json',
      'eve local down --destroy --force',
    ],
  },

  system: {
    description: 'System administration and health checks (admin scope required for most commands).',
    usage: 'eve system <subcommand> [options]',
    subcommands: {
      health: {
        description: 'Quick health check of the API',
        usage: 'eve system health',
        examples: ['eve system health', 'eve system health --json'],
      },
      status: {
        description: 'Show comprehensive system status (admin only)',
        usage: 'eve system status',
        examples: ['eve system status', 'eve system status --json'],
      },
      jobs: {
        description: 'List all jobs across all projects (admin view)',
        usage: 'eve system jobs [--org <id>] [--project <id>] [--phase <phase>] [--limit <n>] [--offset <n>]',
        options: [
          '--org <id>           Filter by organization ID',
          '--project <id>       Filter by project ID',
          '--phase <phase>      Filter by job phase',
          '--limit <n>          Number of results (default: 50)',
          '--offset <n>         Skip first n results',
        ],
        examples: [
          'eve system jobs',
          'eve system jobs --phase active',
          'eve system jobs --project proj_xxx',
        ],
      },
      envs: {
        description: 'List all environments across all projects (admin view)',
        usage: 'eve system envs [--org <id>] [--project <id>] [--limit <n>] [--offset <n>]',
        options: [
          '--org <id>           Filter by organization ID',
          '--project <id>       Filter by project ID',
          '--limit <n>          Number of results (default: 50)',
          '--offset <n>         Skip first n results',
        ],
        examples: [
          'eve system envs',
          'eve system envs --project proj_xxx',
        ],
      },
      logs: {
        description: 'Fetch recent logs for a system service (admin only)',
        usage: 'eve system logs <api|orchestrator|worker|agent-runtime|postgres> [--tail <n>]',
        options: [
          '--tail <n>          Number of log lines (default: 100)',
        ],
        examples: [
          'eve system logs api',
          'eve system logs agent-runtime --tail 200',
          'eve system logs worker --tail 200',
        ],
      },
      pods: {
        description: 'List pods across the cluster (admin only)',
        usage: 'eve system pods',
        examples: ['eve system pods'],
      },
      events: {
        description: 'List recent cluster events (admin only)',
        usage: 'eve system events [--limit <n>]',
        options: [
          '--limit <n>         Max number of events (default: 50)',
        ],
        examples: ['eve system events', 'eve system events --limit 20'],
      },
      config: {
        description: 'Show deployment configuration summary (system admins only)',
        usage: 'eve system config',
        examples: ['eve system config'],
      },
      settings: {
        description: 'Get or set system settings (admin only)',
        usage: 'eve system settings [get <key>] [set <key> <value>]',
        options: [
          'get <key>            Get specific setting',
          'set <key> <value>    Update setting value',
        ],
        examples: [
          'eve system settings',
          'eve system settings get some-key',
          'eve system settings set some-key some-value',
        ],
      },
      orchestrator: {
        description: 'Manage orchestrator concurrency settings',
        usage: 'eve system orchestrator <status|set-concurrency>',
        options: [
          'status                           Show concurrency status',
          'set-concurrency <n>              Set concurrency limit',
        ],
        examples: [
          'eve system orchestrator status',
          'eve system orchestrator set-concurrency 8',
        ],
      },
    },
    examples: [
      'eve system health',
      'eve system status',
      'eve system jobs',
      'eve system envs',
      'eve system logs api',
      'eve system orchestrator status',
    ],
  },
  integrations: {
    description: 'Manage chat integrations (Slack) for an organization.',
    usage: 'eve integrations <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List integrations for an org',
        usage: 'eve integrations list --org <org_id>',
        options: ['--org <id>           Organization ID'],
      },
      slack: {
        description: 'Connect a Slack workspace (stub OAuth)',
        usage: 'eve integrations slack connect --org <org_id> --team-id <team_id> [--token <token>]',
        options: [
          '--org <id>           Organization ID',
          '--team-id <id>       Slack team ID',
          '--token <token>      Slack access token (stored in tokens_json)',
          '--tokens-json <json> Raw tokens_json payload',
          '--status <status>    Integration status (default: active)',
        ],
      },
      test: {
        description: 'Test an integration',
        usage: 'eve integrations test <integration_id>',
      },
    },
    examples: [
      'eve integrations list --org org_xxx',
      'eve integrations slack connect --org org_xxx --team-id T123 --token xoxb-...',
    ],
  },
  notifications: {
    description: 'Send project-scoped notifications through org integrations.',
    usage: 'eve notifications <subcommand> [options]',
    subcommands: {
      send: {
        description: 'Send a Slack channel notification without exposing provider tokens',
        usage: 'eve notifications send --project <project> --channel <channel> --message <text>',
        options: [
          '--project <id>          Project ID or slug (uses profile default)',
          '--channel <name|id>     Slack channel name or ID',
          '--message <text>        Message text to send',
          '--text <text>           Alias for --message',
          '--integration-id <id>   Slack integration ID when the org has multiple workspaces',
          '--thread <ts>           Optional Slack thread timestamp',
          '--json                  Machine-readable output',
        ],
        examples: [
          'eve notifications send --project proj_xxx --channel eve-horizon-notifications --message "Workflow complete"',
          'eve notifications send --channel C0123ABC --message "Build passed" --json',
        ],
      },
    },
    examples: [
      'eve notifications send --project proj_xxx --channel eve-horizon-notifications --message "Workflow complete"',
    ],
  },
  supervise: {
    description: 'Long-poll for child job events and coordination messages. Used by lead agents to stay alive and react.',
    usage: 'eve supervise [job-id] [--timeout <seconds>] [--since <cursor>] [--json]',
    subcommands: {
      '': {
        description: 'Poll for child events and inbox messages',
        usage: 'eve supervise [job-id] [--timeout <seconds>] [--since <cursor>] [--json]',
        options: [
          '[job-id]             Parent job ID (defaults to $EVE_JOB_ID)',
          '--timeout <seconds>  Max wait in seconds (default: 30, max: 120)',
          '--since <cursor>     ISO cursor for incremental polling',
          '--json               Output as JSON',
        ],
        examples: [
          'eve supervise',
          'eve supervise MyProj-abc123 --timeout 60',
          'eve supervise --since 2026-02-08T19:00:00Z --json',
        ],
      },
    },
    examples: [
      'eve supervise',
      'eve supervise MyProj-abc123 --timeout 60',
    ],
  },
  thread: {
    description: 'Manage org-scoped coordination threads for agent team communication.',
    usage: 'eve thread <subcommand> [options]',
    subcommands: {
      create: {
        description: 'Create an org thread',
        usage: 'eve thread create --org <org_id> --key <key>',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--key <key>          Thread key (required)',
        ],
        examples: [
          'eve thread create --org org_xxx --key "project:review"',
        ],
      },
      list: {
        description: 'List threads in an org',
        usage: 'eve thread list --org <org_id> [--scope org] [--key-prefix <prefix>]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--scope <scope>      Filter by scope (e.g., org)',
          '--key-prefix <pfx>   Filter by key prefix',
        ],
        examples: [
          'eve thread list --org org_xxx',
          'eve thread list --org org_xxx --key-prefix "project:"',
        ],
      },
      show: {
        description: 'Show thread details',
        usage: 'eve thread show <thread_id> --org <org_id>',
        options: [
          '--org <id>           Organization ID (uses profile default)',
        ],
        examples: [
          'eve thread show thr_xxx --org org_xxx',
        ],
      },
      messages: {
        description: 'List messages in a coordination thread',
        usage: 'eve thread messages <thread-id> [--since <duration>] [--limit <n>] [--json]',
        options: [
          '--since <duration>   Time window: 5m, 1h, 30s, 2d, or ISO timestamp',
          '--limit <n>          Max messages to return',
          '--json               Output as JSON',
        ],
        examples: [
          'eve thread messages thr_xxx',
          'eve thread messages thr_xxx --since 5m',
          'eve thread messages thr_xxx --since 1h --limit 20 --json',
        ],
      },
      post: {
        description: 'Post a message to a coordination thread',
        usage: 'eve thread post <thread-id> --body <text>',
        options: [
          '--body <text>        Message body (required)',
          '--actor-type <type>  Actor type (default: user)',
          '--actor-id <id>      Actor identifier',
          '--job-id <id>        Associated job ID',
        ],
        examples: [
          'eve thread post thr_xxx --body "hello team"',
          'eve thread post thr_xxx --body \'{"kind":"directive","body":"focus on auth"}\'',
        ],
      },
      follow: {
        description: 'Follow a thread in real-time (SSE for project threads, polling fallback)',
        usage: 'eve thread follow <thread-id>',
        examples: [
          'eve thread follow thr_xxx',
        ],
      },
      distill: {
        description: 'Distill thread messages into durable docs/memory',
        usage: 'eve thread distill <thread-id> --org <org_id> [--to <path>] [--agent <slug>] [--category <name>] [--key <key>]',
        options: [
          '--to <path>          Explicit destination doc path',
          '--agent <slug>       Agent namespace for inferred path',
          '--category <name>    Memory category (learnings|decisions|runbooks|context|conventions)',
          '--key <key>          Memory key for inferred path',
          '--prompt <text>      Distillation prompt override',
          '--auto               Skip if below threshold',
          '--threshold <n>      Minimum message count for --auto',
          '--interval <dur>     Advisory distillation interval metadata',
        ],
        examples: [
          'eve thread distill thr_xxx --org org_xxx --to /agents/shared/memory/decisions/sprint-42.md',
          'eve thread distill thr_xxx --org org_xxx --agent reviewer --category decisions --key sprint-42',
        ],
      },
    },
    examples: [
      'eve thread create --org org_xxx --key "project:review"',
      'eve thread list --org org_xxx',
      'eve thread show thr_xxx --org org_xxx',
      'eve thread messages thr_xxx --since 5m',
      'eve thread post thr_xxx --body "status update"',
      'eve thread follow thr_xxx',
      'eve thread distill thr_xxx --org org_xxx --agent reviewer --category decisions --key sprint-42',
    ],
  },
  chat: {
    description: 'Chat tooling for gateway testing.',
    usage: 'eve chat <subcommand> [options]',
    subcommands: {
      simulate: {
        description: 'Simulate an inbound chat message via the gateway',
        usage: 'eve chat simulate --team-id <team> --text <message>',
        options: [
          '--team-id <id>         Slack team ID (required)',
          '--text <msg>           Message text (required)',
          '--provider <name>      Provider name (default: slack)',
          '--channel-id <id>      Channel ID',
          '--user-id <id>         User ID',
          '--external-email <e>   Email hint for Tier 1 identity auto-match',
          '--dedupe-key <key>     Deduplication key',
          '--event-type <type>    Event type (default: app_mention)',
          '--thread-id <id>       Thread ID override',
          '--metadata <json>      Extra metadata JSON',
          '--project <id>         [deprecated] Legacy API simulate path',
        ],
      },
      send: {
        description: 'Continue an existing Eve chat thread by thread ID',
        usage: 'eve chat send --thread <thread-id> --text <message>',
        options: [
          '--thread <id>          Eve thread ID (required)',
          '--text <msg>           Message text (required)',
          '--actor-id <id>        External/provider actor ID override',
          '--metadata <json>      Extra metadata JSON',
        ],
        examples: [
          'eve chat send --thread thr_xxx --text "what about tests?"',
          'eve chat send --thread thr_xxx --text "follow up" --metadata \'{"eve_user_id":"usr_123"}\'',
        ],
      },
    },
    examples: [
      'eve chat simulate --team-id T123 --text "hello"',
      'eve chat simulate --team-id T123 --text "@eve deploy" --external-email alice@example.com',
      'eve chat simulate --team-id T123 --text "hello" --dedupe-key test-dedup-1',
      'eve chat send --thread thr_xxx --text "follow up"',
    ],
  },
  'app-links': {
    description: 'Inspect cross-project app link grants, subscriptions, and diagnostics.',
    usage: 'eve app-links <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List exports and consumes for a project',
        usage: 'eve app-links list [project] [--project <id>] [--json]',
      },
      plan: {
        description: 'Dry-run consumer app_links against current producer grants',
        usage: 'eve app-links plan --project <id> [--file .eve/manifest.yaml] [--env <env>]',
      },
      explain: {
        description: 'Explain a link by alias or producer/export',
        usage: 'eve app-links explain --consumer <id> (--alias <name> | --producer <id> --api <name>)',
      },
    },
    examples: [
      'eve app-links list --project proj_xxx',
      'eve app-links plan --project proj_consumer --file .eve/manifest.yaml',
      'eve app-links explain --consumer proj_consumer --alias observation',
    ],
  },
  docs: {
    description: 'Manage org documents (versioned).',
    usage: 'eve docs <subcommand> [options]',
    subcommands: {
      write: {
        description: 'Create or update an org document',
        usage: 'eve docs write --org <org_id> --path <doc_path> --file <path> | --stdin',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--path <path>        Document path (required)',
          '--file <path>        Read content from file',
          '--stdin              Read content from stdin',
          '--project <id>       Project ID to associate',
          '--metadata <json>    Document metadata JSON',
          '--review-in <dur>    Set review_due from now (e.g., 30d)',
          '--review-due <iso>   Set explicit review_due timestamp',
          '--expires-in <dur>   Set expires_at from now (e.g., 14d)',
          '--expires-at <iso>   Set explicit expires_at timestamp',
          '--lifecycle-status <s> lifecycle_status override',
        ],
      },
      read: {
        description: 'Read a document (optionally pinned to a version)',
        usage: 'eve docs read --org <org_id> --path <doc_path> [--version <n>]',
      },
      show: {
        description: 'Show document metadata (verbose includes version info)',
        usage: 'eve docs show --org <org_id> --path <doc_path> [--verbose]',
      },
      list: {
        description: 'List documents by path prefix',
        usage: 'eve docs list --org <org_id> [--path <prefix>]',
      },
      search: {
        description: 'Full-text search documents',
        usage: 'eve docs search --org <org_id> --query <text> [--limit <n>] [--mode text|semantic|hybrid]',
      },
      stale: {
        description: 'List stale documents by review_due age',
        usage: 'eve docs stale --org <org_id> [--overdue-by 7d] [--prefix <path>] [--limit <n>]',
      },
      review: {
        description: 'Mark a document reviewed and set next review date',
        usage: 'eve docs review --org <org_id> --path <doc_path> --next-review <duration|iso>',
      },
      versions: {
        description: 'List document versions',
        usage: 'eve docs versions --org <org_id> --path <doc_path> [--limit <n>] [--offset <n>]',
      },
      query: {
        description: 'Structured metadata query',
        usage: 'eve docs query --org <org_id> [--path-prefix <prefix>] --where "metadata.foo eq bar"',
      },
      delete: {
        description: 'Delete a document',
        usage: 'eve docs delete --org <org_id> --path <doc_path>',
      },
    },
    examples: [
      'eve docs write --org org_xxx --path /pm/features/FEAT-123.md --file ./feat.md',
      'eve docs write --org org_xxx --path /agents/reviewer/memory/learnings/auth.md --file ./auth.md --review-in 30d',
      'eve docs stale --org org_xxx --overdue-by 7d',
      'eve docs review --org org_xxx --path /agents/reviewer/memory/learnings/auth.md --next-review 30d',
      'eve docs read --org org_xxx --path /pm/features/FEAT-123.md --version 3',
      'eve docs versions --org org_xxx --path /pm/features/FEAT-123.md',
      'eve docs query --org org_xxx --where "metadata.feature_status in draft,review"',
    ],
  },
  memory: {
    description: 'Manage canonical agent memory namespaces backed by org docs.',
    usage: 'eve memory <set|get|list|delete|search> [options]',
    subcommands: {
      set: {
        description: 'Create or update a memory entry',
        usage: 'eve memory set --org <org_id> (--agent <slug>|--shared) --category <name> --key <key> (--file <path>|--stdin|--content <text>)',
      },
      get: {
        description: 'Read a memory entry by key',
        usage: 'eve memory get --org <org_id> (--agent <slug>|--shared) --key <key> [--category <name>]',
      },
      list: {
        description: 'List memory entries by namespace/category',
        usage: 'eve memory list --org <org_id> (--agent <slug>|--shared) [--category <name>] [--tags a,b] [--limit <n>]',
      },
      delete: {
        description: 'Delete a memory entry',
        usage: 'eve memory delete --org <org_id> (--agent <slug>|--shared) --category <name> --key <key>',
      },
      search: {
        description: 'Search memory across agent/shared namespaces',
        usage: 'eve memory search --org <org_id> --query <text> [--agent <slug>] [--limit <n>]',
      },
    },
    examples: [
      'eve memory set --org org_xxx --agent reviewer --category learnings --key auth-retry --file ./finding.md --tags auth,security',
      'eve memory set --org org_xxx --shared --category conventions --key api-style --file ./style.md',
      'eve memory list --org org_xxx --agent reviewer --category learnings',
      'eve memory search --org org_xxx --query "authentication retry"',
    ],
  },
  kv: {
    description: 'Manage agent KV state with optional TTL.',
    usage: 'eve kv <set|get|list|mget|delete> [options]',
    subcommands: {
      set: {
        description: 'Set a KV value',
        usage: 'eve kv set --org <org_id> --agent <slug> --key <key> --value <json-or-string> [--namespace <ns>] [--ttl <seconds>]',
      },
      get: {
        description: 'Get a KV value',
        usage: 'eve kv get --org <org_id> --agent <slug> --key <key> [--namespace <ns>]',
      },
      list: {
        description: 'List keys in a namespace',
        usage: 'eve kv list --org <org_id> --agent <slug> [--namespace <ns>] [--limit <n>]',
      },
      mget: {
        description: 'Batch get keys',
        usage: 'eve kv mget --org <org_id> --agent <slug> --keys a,b,c [--namespace <ns>]',
      },
      delete: {
        description: 'Delete a KV value',
        usage: 'eve kv delete --org <org_id> --agent <slug> --key <key> [--namespace <ns>]',
      },
    },
    examples: [
      'eve kv set --org org_xxx --agent reviewer --key last_commit --value \'"abc123"\' --ttl 86400',
      'eve kv mget --org org_xxx --agent reviewer --keys last_commit,focus_area',
    ],
  },
  search: {
    description: 'Unified org search across memory/docs/threads/attachments/events.',
    usage: 'eve search --org <org_id> --query <text> [--sources memory,docs,threads,attachments,events] [--limit <n>] [--agent <slug>]',
    subcommands: {
      '': {
        description: 'Run unified search',
        usage: 'eve search --org <org_id> --query <text> [--sources memory,docs,threads,attachments,events] [--limit <n>] [--agent <slug>]',
      },
    },
    examples: [
      'eve search --org org_xxx --query "authentication retry"',
      'eve search --org org_xxx --query "authentication retry" --sources memory,docs,threads --agent reviewer',
    ],
  },
  fs: {
    description: 'Manage org filesystem sync links, events, and diagnostics.',
    usage: 'eve fs sync <subcommand> [options]',
    subcommands: {
      sync: {
        description: 'Org filesystem sync operations',
        usage: 'eve fs sync <init|status|logs|pause|resume|disconnect|mode|conflicts|resolve|doctor> [options]',
        options: [
          'init: --org <id> --local <path> [--mode two-way|push-only|pull-only]',
          'status: --org <id>',
          'logs: --org <id> [--after <seq>] [--limit <n>] [--follow]',
          'pause|resume|disconnect: --org <id> [--link <link_id>]',
          'mode: --org <id> --set <two-way|push-only|pull-only> [--link <link_id>]',
          'conflicts: --org <id> [--open-only]',
          'resolve: --org <id> --conflict <id> --strategy <pick-remote|pick-local|manual>',
          'doctor: --org <id>',
        ],
      },
    },
    examples: [
      'eve fs sync init --org org_xxx --local ~/Eve/acme --mode two-way',
      'eve fs sync status --org org_xxx',
      'eve fs sync logs --org org_xxx --follow',
      'eve fs sync mode --org org_xxx --set pull-only',
      'eve fs sync doctor --org org_xxx',
    ],
  },
  'cloud-fs': {
    description: 'Manage cloud storage mounts (Google Drive, Box, OneDrive).\nMount cloud folders to your org or project, browse files, and search.',
    usage: 'eve cloud-fs <subcommand> [options]',
    subcommands: {
      list: {
        description: 'List all cloud FS mounts for the org',
        usage: 'eve cloud-fs list [--org <org_id>] [--project <id>]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--project <id>       Filter mounts scoped to this project',
        ],
      },
      mount: {
        description: 'Create a new cloud FS mount',
        usage: 'eve cloud-fs mount --provider <name> --folder-id <id> [options]',
        options: [
          '--provider <name>       Cloud storage provider (e.g., google-drive)',
          '--folder-id <id>        Provider folder ID to mount',
          '--project <id>          Scope mount to a project (default: org-level)',
          '--label <text>          Human-readable label',
          '--integration <id>      Integration to use (auto-detected if omitted)',
          '--mode <mode>           Access mode: read_only, write_only, read_write (default: read_write)',
          '--auto-index <bool>     Auto-index files to org docs (default: true)',
        ],
        examples: [
          'eve cloud-fs mount --provider google-drive --folder-id 0ABxxx --label "Shared Drive"',
          'eve cloud-fs mount --provider google-drive --folder-id 1aBcD --project proj_xxx --label "Project Docs"',
        ],
      },
      unmount: {
        description: 'Remove a cloud FS mount',
        usage: 'eve cloud-fs unmount <mount_id>',
        examples: ['eve cloud-fs unmount cfm_xxx'],
      },
      show: {
        description: 'Show details for a specific mount',
        usage: 'eve cloud-fs show <mount_id>',
        examples: ['eve cloud-fs show cfm_xxx'],
      },
      update: {
        description: 'Update mount settings',
        usage: 'eve cloud-fs update <mount_id> [--label <text>] [--mode <mode>] [--auto-index <bool>]',
        options: [
          '--label <text>          Update the human-readable label',
          '--mode <mode>           Change access mode (read_only, write_only, read_write)',
          '--auto-index <bool>     Enable/disable auto-indexing',
        ],
      },
      ls: {
        description: 'Browse files at a path in a cloud FS mount',
        usage: 'eve cloud-fs ls [path] [--mount <mount_id>] [--all|--page-token <token>] [--recursive]',
        options: [
          '--mount <id>            Specific mount to browse (default: org mount)',
          '--all                   Fetch all provider pages up to the auto-page cap',
          '--page-token <token>    Fetch a specific provider page',
          '--page-size <n>         Requested page size (server clamps provider maximum)',
          '--order-by <value>      name, name_desc, modified, or modified_desc',
          '--recursive, -r         Return a bounded recursive listing (no page token)',
        ],
        examples: [
          'eve cloud-fs ls /',
          'eve cloud-fs ls /Q1-Reports/ --mount cfm_xxx',
          'eve cloud-fs ls / --mount cfm_xxx --page-size 25 --all',
          'eve cloud-fs ls / --mount cfm_xxx --recursive --json',
        ],
      },
      search: {
        description: 'Search files across cloud FS mounts',
        usage: 'eve cloud-fs search <query> [--mount <mount_id>] [--mime-type <type>] [--all|--page-token <token>]',
        options: [
          '--mount <id>            Limit search to a specific mount',
          '--mime-type <type>      Filter by MIME type',
          '--all                   Fetch all provider pages up to the auto-page cap',
          '--page-token <token>    Fetch a specific provider page',
          '--page-size <n>         Requested page size (server clamps provider maximum)',
          '--order-by <value>      name, name_desc, modified, or modified_desc',
        ],
        examples: [
          'eve cloud-fs search "Q4 board deck"',
          'eve cloud-fs search "budget" --mount cfm_xxx --mime-type application/pdf',
          'eve cloud-fs search "budget" --mount cfm_xxx --all --json',
        ],
      },
    },
    examples: [
      'eve cloud-fs list',
      'eve cloud-fs mount --provider google-drive --folder-id 0ABxxx --label "Shared Drive"',
      'eve cloud-fs show cfm_xxx',
      'eve cloud-fs ls / --mount cfm_xxx --all',
      'eve cloud-fs search "Q4 report"',
      'eve cloud-fs unmount cfm_xxx',
    ],
  },
  resources: {
    description: 'Resolve resource URIs into content snapshots.',
    usage: 'eve resources <subcommand> [options]',
    subcommands: {
      resolve: {
        description: 'Resolve a resource URI (optionally without content)',
        usage: 'eve resources resolve <uri> [--no-content]',
      },
      ls: {
        description: 'List resources under a URI prefix',
        usage: 'eve resources ls <uri-prefix>',
      },
      cat: {
        description: 'Output resource content',
        usage: 'eve resources cat <uri>',
      },
    },
    examples: [
      'eve resources resolve org_docs:/pm/features/FEAT-123.md',
      'eve resources ls org_docs:/pm/features/',
      'eve resources cat job_attachments:/myproj-a3f2dd12/plan.md',
    ],
  },
  webhooks: {
    description: 'Manage outbound webhook subscriptions and delivery logs.',
    usage: 'eve webhooks <subcommand> [options]',
    subcommands: {
      create: {
        description: 'Create a webhook subscription',
        usage: 'eve webhooks create --org <org_id> --url <url> --events <evt1,evt2> --secret <secret> [--filter \'{"key":"val"}\'] [--project <id>]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--url <url>          Delivery endpoint URL (required)',
          '--events <list>      Comma-separated event types to subscribe to (required)',
          '--secret <secret>    HMAC signing secret, min 16 chars (required)',
          '--filter <json>      Optional JSON filter object',
          '--project <id>       Scope webhook to a specific project',
        ],
        examples: [
          'eve webhooks create --org org_xxx --url https://example.com/hook --events system.job.completed --secret my-secret-key-1234',
          'eve webhooks create --org org_xxx --url https://example.com/hook --events "system.job.*" --secret my-secret-key-1234 --filter \'{"agent_slug":"pm-*"}\'',
        ],
      },
      list: {
        description: 'List webhook subscriptions for an org',
        usage: 'eve webhooks list --org <org_id>',
        options: ['--org <id>           Organization ID (uses profile default)'],
      },
      show: {
        description: 'Show webhook subscription details',
        usage: 'eve webhooks show <webhook_id> --org <org_id>',
        options: ['--org <id>           Organization ID (uses profile default)'],
        examples: ['eve webhooks show wh_xxx --org org_xxx'],
      },
      deliveries: {
        description: 'List delivery attempts for a webhook subscription',
        usage: 'eve webhooks deliveries <webhook_id> --org <org_id> [--limit <n>]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--limit <n>          Max results (default: 50)',
        ],
      },
      test: {
        description: 'Send a test webhook event',
        usage: 'eve webhooks test <webhook_id> --org <org_id>',
        options: ['--org <id>           Organization ID (uses profile default)'],
      },
      delete: {
        description: 'Delete a webhook subscription',
        usage: 'eve webhooks delete <webhook_id> --org <org_id>',
        options: ['--org <id>           Organization ID (uses profile default)'],
      },
      enable: {
        description: 'Re-enable a disabled webhook subscription',
        usage: 'eve webhooks enable <webhook_id> --org <org_id>',
        options: ['--org <id>           Organization ID (uses profile default)'],
      },
      replay: {
        description: 'Replay webhook deliveries for a subscription',
        usage: 'eve webhooks replay <webhook_id> --org <org_id> [--from-event <id>] [--to <iso>] [--max-events <n>] [--dry-run]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--from-event <id>    Event ID to start replay from (inclusive)',
          '--to <iso>           ISO timestamp for end of replay window (default: now)',
          '--max-events <n>     Max events to scan (default: 5000, max: 10000)',
          '--dry-run            Return summary without enqueuing deliveries',
        ],
        examples: [
          'eve webhooks replay wh_xxx --org org_xxx --from-event evt_123',
          'eve webhooks replay wh_xxx --org org_xxx --to 2026-02-12T12:00:00Z --max-events 2000 --dry-run',
        ],
      },
      'replay-status': {
        description: 'Fetch webhook replay status',
        usage: 'eve webhooks replay-status <webhook_id> <replay_id> --org <org_id>',
        options: ['--org <id>           Organization ID (uses profile default)'],
        examples: ['eve webhooks replay-status wh_xxx rpl_xxx --org org_xxx'],
      },
    },
    examples: [
      'eve webhooks create --org org_xxx --url https://example.com/hook --events system.job.completed --secret my-secret-key-1234',
      'eve webhooks list --org org_xxx',
      'eve webhooks deliveries wh_xxx --org org_xxx',
      'eve webhooks test wh_xxx --org org_xxx',
      'eve webhooks delete wh_xxx --org org_xxx',
      'eve webhooks replay wh_xxx --org org_xxx --dry-run',
    ],
  },

  analytics: {
    description: 'View org-wide analytics: job counts, pipeline success rates, and environment health.',
    usage: 'eve analytics <subcommand> [options]',
    subcommands: {
      summary: {
        description: 'Org-wide activity summary (jobs, pipelines, environments)',
        usage: 'eve analytics summary --org <org_id> [--window <duration>] [--json]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--window <duration>  Time window (e.g., 7d, 24h, 30d). Default: 7d',
          '--json               Output raw JSON',
        ],
        examples: [
          'eve analytics summary --org org_xxx',
          'eve analytics summary --org org_xxx --window 30d',
          'eve analytics summary --org org_xxx --json',
        ],
      },
      jobs: {
        description: 'Job breakdown for the given time window',
        usage: 'eve analytics jobs --org <org_id> [--window <duration>] [--json]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--window <duration>  Time window (e.g., 7d, 24h, 30d). Default: 7d',
          '--json               Output raw JSON',
        ],
        examples: [
          'eve analytics jobs --org org_xxx',
          'eve analytics jobs --org org_xxx --window 24h --json',
        ],
      },
      pipelines: {
        description: 'Pipeline success rates and durations',
        usage: 'eve analytics pipelines --org <org_id> [--window <duration>] [--json]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--window <duration>  Time window (e.g., 7d, 24h, 30d). Default: 7d',
          '--json               Output raw JSON',
        ],
        examples: [
          'eve analytics pipelines --org org_xxx',
          'eve analytics pipelines --org org_xxx --window 30d',
        ],
      },
      'env-health': {
        description: 'Current environment health snapshot',
        usage: 'eve analytics env-health --org <org_id> [--json]',
        options: [
          '--org <id>           Organization ID (uses profile default)',
          '--json               Output raw JSON',
        ],
        examples: [
          'eve analytics env-health --org org_xxx',
          'eve analytics env-health --org org_xxx --json',
        ],
      },
    },
    examples: [
      'eve analytics summary --org org_xxx',
      'eve analytics summary --org org_xxx --window 30d --json',
      'eve analytics jobs --org org_xxx --window 24h',
      'eve analytics pipelines --org org_xxx',
      'eve analytics env-health --org org_xxx',
    ],
  },

  endpoint: {
    description: 'Manage private endpoints — Tailscale-connected services accessible from within the K8s cluster.',
    usage: 'eve endpoint <subcommand> [options]',
    subcommands: {
      add: {
        description: 'Register a private endpoint backed by Tailscale',
        usage: 'eve endpoint add --name <name> --tailscale-hostname <fqdn> --port <port> --org <org_id> [--health-path <path>]',
        options: [
          '--name <name>                 DNS-safe endpoint name',
          '--tailscale-hostname <fqdn>   Tailscale MagicDNS hostname (e.g., mac-mini.tail12345.ts.net)',
          '--port <port>                 Service port (1-65535)',
          '--org <id>                    Organization ID or slug',
          '--health-path <path>          HTTP health check path (default: /v1/models, "none" to disable)',
        ],
        examples: [
          'eve endpoint add --name lmstudio --tailscale-hostname mac-mini.tail12345.ts.net --port 1234 --org org_xxx',
        ],
      },
      list: {
        description: 'List registered endpoints for an org',
        usage: 'eve endpoint list --org <org_id>',
        examples: ['eve endpoint list --org org_xxx'],
      },
      show: {
        description: 'Show endpoint details and optionally run a health check',
        usage: 'eve endpoint show <name> --org <org_id> [--verbose]',
        options: [
          '--verbose   Run and display a health check',
        ],
        examples: ['eve endpoint show lmstudio --org org_xxx --verbose'],
      },
      remove: {
        description: 'Remove a private endpoint and its K8s Service',
        usage: 'eve endpoint remove <name> --org <org_id>',
        examples: ['eve endpoint remove lmstudio --org org_xxx'],
      },
      health: {
        description: 'Run a health check against a private endpoint',
        usage: 'eve endpoint health <name> --org <org_id>',
        examples: ['eve endpoint health lmstudio --org org_xxx'],
      },
      diagnose: {
        description: 'Run diagnostic checks on a private endpoint',
        usage: 'eve endpoint diagnose <name> --org <org_id>',
        examples: ['eve endpoint diagnose lmstudio --org org_xxx'],
      },
    },
    examples: [
      'eve endpoint add --name lmstudio --tailscale-hostname mac-mini.tail12345.ts.net --port 1234 --org org_xxx',
      'eve endpoint list --org org_xxx',
      'eve endpoint show lmstudio --org org_xxx --verbose',
      'eve endpoint diagnose lmstudio --org org_xxx',
    ],
  },

  'tcp-ingress': {
    description: 'Test public TCP ingress listeners from this machine.',
    usage: 'eve tcp-ingress <subcommand> [options]',
    subcommands: {
      test: {
        description: 'Run a TCP connect probe against a public listener',
        usage: 'eve tcp-ingress test <project> <env> --listener <name> [--timeout <seconds>] [--json]',
        options: [
          '<project>             Project ID or slug (uses profile default if omitted)',
          '<env>                 Environment name',
          '--listener <name>     TCP ingress listener name',
          '--timeout <seconds>   Connect timeout (default: 5)',
          '--json                Output probe result as JSON',
        ],
        examples: [
          'eve tcp-ingress test proj_xxx staging --listener a1-gt06',
          'eve tcp-ingress test proj_xxx staging --listener mictrack-mt700 --timeout 10 --json',
        ],
      },
    },
    examples: [
      'eve tcp-ingress test proj_xxx staging --listener a1-gt06',
    ],
  },


  migrate: {
    description: 'Migration helpers for upgrading config formats.',
    usage: 'eve migrate <subcommand>',
    subcommands: {
      'skills-to-packs': {
        description: 'Generate AgentPack config from skills.txt',
        usage: 'eve migrate skills-to-packs',
        examples: [
          'eve migrate skills-to-packs',
          'eve migrate skills-to-packs > packs-fragment.yaml',
        ],
      },
    },
    examples: [
      'eve migrate skills-to-packs',
    ],
  },

  github: {
    description: 'Set up GitHub webhook integration.\nOne command to connect GitHub push/PR events to Eve pipelines.',
    usage: 'eve github <subcommand> [options]',
    subcommands: {
      setup: {
        description: 'Configure GitHub webhook (auto-creates via gh CLI if available)',
        usage: 'eve github setup [--project <id>] [--regenerate]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--regenerate         Generate a new webhook secret (replaces existing)',
          '--json               Output as JSON',
        ],
        examples: [
          'eve github setup',
          'eve github setup --project proj_xxx',
          'eve github setup --regenerate',
        ],
      },
      status: {
        description: 'Check if GitHub webhook is configured',
        usage: 'eve github status [--project <id>]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--json               Output as JSON',
        ],
        examples: [
          'eve github status',
        ],
      },
      test: {
        description: 'Send a test github.push event to verify pipeline triggers',
        usage: 'eve github test [--project <id>]',
        options: [
          '--project <id>       Project ID (uses profile default)',
          '--json               Output as JSON',
        ],
        examples: [
          'eve github test',
          'eve github test --project proj_xxx',
        ],
      },
    },
    examples: [
      'eve github setup                  # Auto-create webhook via gh CLI',
      'eve github setup --regenerate     # Rotate webhook secret',
      'eve github status                 # Check if configured',
      'eve github test                   # Fire test event',
    ],
  },
};

export function showMainHelp(): void {
  console.log('Eve Horizon CLI');
  console.log('');
  console.log('Usage: eve <command> [subcommand] [options]');
  console.log('');
  console.log('Getting Started:');
  console.log('  init       Initialize a new project from template');
  console.log('');
  console.log('Commands:');
  console.log('  org        Manage organizations');
  console.log('  project    Manage projects');
  console.log('  manifest   Validate manifests (schema, secrets)');
  console.log('  local      Manage local k3d stack lifecycle and diagnostics');
  console.log('  job        Manage jobs (create, list, show, update, claim, etc.)');
  console.log('  env        Manage environments (list, show, deploy)');
  console.log('  domain     Manage custom domains for services');
  console.log('  build      Manage builds (create, run, logs, artifacts)');
  console.log('  release    Manage and inspect releases');
  console.log('  api        Explore API sources and call endpoints');
  console.log('  db         Inspect env DB schema, RLS, and SQL');
  console.log('  pipeline   Inspect manifest pipelines (list, show)');
  console.log('  workflow   Inspect, invoke, and retry manifest workflows');
  console.log('  event      Emit and inspect events (app integration)');
  console.log('  app-links  Inspect cross-project app links');
  console.log('  docs       Manage org documents');
  console.log('  fs         Manage org filesystem sync');
  console.log('  cloud-fs   Manage cloud storage mounts (Google Drive, etc.)');
  console.log('  resources  Resolve org/job resources');
  console.log('  secrets    Manage secrets (project/org/user scope)');
  console.log('  harness    Inspect harnesses and auth status');
  console.log('  agents     Inspect agent policy and harness capabilities');
  console.log('  packs      Manage AgentPack lockfile and resolution');
  console.log('  github     Set up GitHub webhook integration');
  console.log('  integrations  Manage chat integrations (Slack)');
  console.log('  notifications  Send Slack/channel notifications');
  console.log('  chat       Simulate chat messages (gateway testing)');
  console.log('  supervise   Long-poll child events (lead agent coordination)');
  console.log('  thread     Manage coordination threads (agent teams)');
  console.log('  profile    Manage CLI profiles (API URL, defaults)');
  console.log('  auth       Authentication (login, logout, status)');
  console.log('  webhooks   Manage outbound webhook subscriptions');
  console.log('  analytics  Org analytics (jobs, pipelines, env health)');
  console.log('  endpoint   Manage private endpoints (Tailscale-connected services)');
  console.log('  tcp-ingress  Test public TCP ingress listeners');

  console.log('  access     Access control: permissions, roles, bindings, policy-as-code sync');
  console.log('  user       Look up user profiles and memberships');
  console.log('  admin      User and platform admin operations');
  console.log('  skills     Install skills from skills.txt (skills CLI)');
  console.log('  migrate    Migration helpers for upgrading config formats');
  console.log('  system     System health and status checks');
  console.log('');
  console.log('Global options:');
  console.log('  --help               Show help for command');
  console.log('  --api-url <url>      Override API URL');
  console.log('  --profile <name>     Use named repo profile');
  console.log('  --org <id>           Override default org');
  console.log('  --project <id>       Override default project');
  console.log('  --json               Output as JSON');
  console.log('');
  console.log('Examples:');
  console.log('  eve org ensure "My Company"');
  console.log('  eve project ensure --name my-app --slug MyApp');
  console.log('  eve job create --description "Fix the bug in auth.ts"');
  console.log('  eve job list --phase ready');
  console.log('  eve job show MyProj-abc123');
  console.log('');
  console.log('Run "eve <command> --help" for more information on a command.');
}

export function showCommandHelp(command: string): void {
  const help = HELP[command];
  if (!help) {
    console.log(`Unknown command: ${command}`);
    console.log('Run "eve --help" for available commands.');
    return;
  }

  console.log(`eve ${command} - ${help.description.split('\n')[0]}`);
  console.log('');

  if (help.description.includes('\n')) {
    console.log(help.description);
    console.log('');
  }

  console.log(`Usage: ${help.usage}`);
  console.log('');

  if (help.subcommands) {
    console.log('Subcommands:');
    const maxLen = Math.max(...Object.keys(help.subcommands).map(k => k.length));
    for (const [name, sub] of Object.entries(help.subcommands)) {
      console.log(`  ${name.padEnd(maxLen + 2)} ${sub.description}`);
    }
    console.log('');
  }

  if (help.examples && help.examples.length > 0) {
    console.log('Examples:');
    help.examples.forEach(ex => console.log(`  ${ex}`));
    console.log('');
  }

  console.log(`Run "eve ${command} <subcommand> --help" for subcommand details.`);
}

export function showSubcommandHelp(command: string, subcommand: string): void {
  const cmdHelp = HELP[command];
  if (!cmdHelp) {
    console.log(`Unknown command: ${command}`);
    return;
  }

  const subHelp = cmdHelp.subcommands?.[subcommand];
  if (!subHelp) {
    console.log(`Unknown subcommand: ${command} ${subcommand}`);
    console.log(`Run "eve ${command} --help" for available subcommands.`);
    return;
  }

  console.log(`eve ${command} ${subcommand} - ${subHelp.description}`);
  console.log('');
  console.log(`Usage: ${subHelp.usage}`);

  if (subHelp.options && subHelp.options.length > 0) {
    console.log('');
    console.log('Options:');
    subHelp.options.forEach(opt => console.log(`  ${opt}`));
  }

  if (subHelp.examples && subHelp.examples.length > 0) {
    console.log('');
    console.log('Examples:');
    subHelp.examples.forEach(ex => console.log(`  ${ex}`));
  }
}

export function shouldShowHelp(
  subcommand: string | undefined,
  flags: Record<string, unknown>,
): 'command' | 'subcommand' | false {
  if (flags.help || flags.h) {
    return subcommand ? 'subcommand' : 'command';
  }
  if (subcommand === '--help' || subcommand === '-h') {
    return 'command';
  }
  if (!subcommand) {
    return 'command';
  }
  return false;
}

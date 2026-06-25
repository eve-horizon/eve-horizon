# CD Pipelines

> **Idea / Draft**: This is a brainstorming document and may not reflect current behavior.
> Note: `.eve/services.yaml` references are deprecated; use `.eve/manifest.yaml` with `services`.
> Many examples use legacy pipeline `actions`; v2 manifests use `pipelines.<name>.steps`.
> See `docs/system/manifest.md` and `docs/system/pipelines.md` for the current spec.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Idea
> Last Updated: 2026-01-17

## Context

Eve Horizon orchestrates CI/CD for **many projects**. Each project:
- Has its own repo, environments, and deployment pipelines
- Defines what "deploy to staging" means for that project
- Owns its `.eve/` configuration

Eve provides:
- Execution environment (agents, services)
- Approval workflows
- Audit logging
- Cross-project visibility

Eve's own CI/CD (self-validation) can use standard GitHub Actions — it's just another project.

## Principles

1. **Project-scoped** — every command includes project context
2. **Project-defined** — projects own their pipeline definitions
3. **CLI-complete** — every action available via `eve` CLI
4. **Skill-ready** — CLI enables agent skills to orchestrate CD
5. **Auditable** — every decision logged with reasoning
6. **Multi-cluster native** — projects can deploy to isolated infrastructure

---

## Project Structure

```
my-project/
├── .eve/
│   ├── services.yaml       # Legacy (deprecated)
│   ├── environments.yaml   # Deploy targets for THIS project
│   └── pipelines.yaml      # CI/CD pipelines for THIS project
└── ...
```

Each project's `.eve/` config is independent. Eve reads it when running jobs for that project.

---

## Environments

Environments are **per-project** deploy targets.

### Definition

```yaml
# my-project/.eve/environments.yaml

project: proj_myapp  # Explicit project binding

environments:
  dev:
    url: https://dev.myapp.com
    namespace: myapp-dev
    deploy:
      method: kubectl
      manifests: k8s/overlays/dev

  staging:
    url: https://staging.myapp.com
    namespace: myapp-staging
    cluster: example-cluster  # Which k8s cluster
    deploy:
      method: kubectl
      manifests: k8s/overlays/staging

  production:
    url: https://myapp.com
    namespace: myapp-prod
    cluster: prod-cluster  # Different cluster for production
    deploy:
      method: argocd
      app: myapp-prod
    approval:
      required: true
      approvers:
        - team: myapp-team
        - user: @alice
```

### CLI Commands

```bash
# List environments for a project
eve env list --project proj_myapp

# Show environment details
eve env show staging --project proj_myapp

# Get environment status
eve env show proj_myapp production
# Output:
#   Project: proj_myapp
#   Environment: production
#   URL: https://myapp.com
#   Cluster: prod-cluster
#   Current Version: v1.2.3
#   Last Deploy: 2026-01-17 10:00:00 by @alice
#   Health: healthy

# List all environments across all projects (admin view)
eve env list --all
```

---

## Deployments

Deployments are **per-project, per-environment**.

### CLI Commands

```bash
# Deploy to environment
eve deploy staging --project proj_myapp --version v1.2.4
eve deploy staging --project proj_myapp --version v1.2.4 --wait

# Deploy from branch/ref
eve deploy staging --project proj_myapp --ref main

# Deploy to production (triggers approval)
eve deploy production --project proj_myapp --version v1.2.4
# Output:
#   Project: proj_myapp
#   Deployment dep_xxx created (pending approval)
#   Target: production (cluster: prod-cluster)
#   Version: v1.2.4
#
#   Awaiting approval from: [myapp-team, @alice]
#
#   To approve: eve deployment approve dep_xxx --project proj_myapp
#   To check:   eve deployment show dep_xxx --project proj_myapp

# List deployments for a project
eve deployment list --project proj_myapp
eve deployment list --project proj_myapp --env production
eve deployment list --project proj_myapp --pending

# Show deployment details
eve deployment show dep_xxx --project proj_myapp

# Approve/reject deployment
eve deployment approve dep_xxx --project proj_myapp
eve deployment approve dep_xxx --project proj_myapp --reason "staging tests passed"
eve deployment reject dep_xxx --project proj_myapp --reason "need to fix migration"

# Rollback
eve deployment rollback production --project proj_myapp
eve deployment rollback production --project proj_myapp --to v1.2.2

# Deployment history
eve deployment history production --project proj_myapp
```

### Deployment Record

```typescript
interface Deployment {
  id: string;
  projectId: string;  // Always scoped to project
  environment: string;
  cluster?: string;
  version: string;

  status: 'pending_approval' | 'approved' | 'rejected' | 'deploying' | 'deployed' | 'failed' | 'rolled_back';

  triggeredBy: {
    type: 'job' | 'user' | 'pipeline';
    id: string;
  };

  approval?: {
    required: boolean;
    approvers: { type: 'user' | 'team'; id: string; }[];
    expiresAt: Date;
    resolution?: {
      status: 'approved' | 'rejected' | 'expired';
      by?: string;
      at?: Date;
      reason?: string;
    };
  };

  startedAt?: Date;
  completedAt?: Date;
}
```

---

## Pipelines

Pipelines are **per-project** workflow definitions.

### Definition

```yaml
# my-project/.eve/pipelines.yaml

project: proj_myapp

pipelines:
  ci:
    description: Run tests on every push
    trigger:
      event: push
      branches: ['*']

    stages:
      - name: test
        job:
          description: Run test suite
        run: |
          pnpm install
          pnpm test

  deploy-to-prod:
    description: Deploy to production after merge to main
    trigger:
      event: push
      branch: main

    stages:
      - name: deploy-staging
        deploy:
          environment: staging
          version: ${GIT_SHA}
          wait: true

      - name: e2e-tests
        job:
          description: Run e2e tests against staging
          environment: staging
        run: pnpm test:e2e
        depends_on: deploy-staging

      - name: deploy-prod
        deploy:
          environment: production
          version: ${GIT_SHA}
        depends_on: e2e-tests
        # Approval required (defined in environments.yaml)

      - name: smoke-tests
        job:
          description: Run smoke tests against production
          environment: production
        run: pnpm test:smoke
        depends_on: deploy-prod
        on_failure:
          rollback: production
```

### CLI Commands

```bash
# List pipelines for a project
eve pipeline list --project proj_myapp

# Show pipeline definition
eve pipeline show deploy-to-prod --project proj_myapp

# Trigger pipeline manually
eve pipeline run deploy-to-prod --project proj_myapp
eve pipeline run deploy-to-prod --project proj_myapp --version v1.2.4

# Check pipeline run status
eve pipeline status run_xxx --project proj_myapp
eve pipeline status run_xxx --project proj_myapp --follow

# List pipeline runs
eve pipeline runs --project proj_myapp
eve pipeline runs --project proj_myapp --pipeline deploy-to-prod
eve pipeline runs --project proj_myapp --status running

# View logs
eve pipeline logs run_xxx --project proj_myapp
eve pipeline logs run_xxx --project proj_myapp --stage e2e-tests

# Cancel
eve pipeline cancel run_xxx --project proj_myapp
```

---

## Deployment Topologies

Eve supports different deployment topologies depending on security/isolation needs.

### Topology A: Single Eve, Multiple Clusters

Simplest setup. One Eve instance manages everything, deploys to multiple k8s clusters.

```
┌─────────────────────┐
│  Eve Instance       │
└──────────┬──────────┘
           │
   ┌───────┼───────┬───────────┐
   ▼       ▼       ▼           ▼
┌──────┐┌──────┐┌──────┐  ┌──────┐
│ dev  ││staging││ prod │  │prod-eu│
└──────┘└──────┘└──────┘  └──────┘
```

```yaml
# Eve instance config
clusters:
  default:
    context: dev-cluster
  staging:
    context: example-cluster
  prod:
    context: prod-cluster
  prod-eu:
    context: prod-eu-cluster
```

### Topology B: Federated Eve (Hardened Production)

Two Eve instances: default for dev/staging, hardened for production.
Default Eve requests deployments from hardened Eve via API.

```
┌─────────────────────┐      ┌─────────────────────┐
│  Eve (Default)      │      │  Eve (Hardened)     │
│  - dev/staging      │─────▶│  - prod only        │
│  - pipelines        │ API  │  - limited access   │
└──────────┬──────────┘      └──────────┬──────────┘
           │                            │
   ┌───────┴───────┐                    │
   ▼               ▼                    ▼
┌──────┐      ┌──────┐             ┌──────┐
│ dev  │      │staging│            │ prod │
└──────┘      └──────┘             └──────┘
```

```yaml
# Project config can reference remote Eve instance
# my-project/.eve/environments.yaml

environments:
  staging:
    cluster: staging  # Local cluster

  production:
    eve: prod-eve     # Different Eve instance
    cluster: prod     # Cluster on that Eve instance
    approval:
      required: true
```

```yaml
# CLI config (~/.eve/config.yaml)
instances:
  default:
    url: https://eve.internal

  prod-eve:
    url: https://eve-prod.internal
    # Separate auth, stricter access
```

### Topology C: Customer-Managed Eve

Customers run their own Eve instances with their own clusters.
Completely isolated from the platform operator's infrastructure.

```
the platform operator                          Customer X
───────                          ──────────
┌─────────────────┐              ┌─────────────────┐
│  Eve (the platform operator)  │              │  Eve (Customer) │
│  - proj_myapp   │              │  - proj_custapp │
└────────┬────────┘              └────────┬────────┘
         │                                │
  ┌──────┴──────┐                  ┌──────┴──────┐
  ▼             ▼                  ▼             ▼
┌────┐      ┌──────┐            ┌────┐      ┌──────┐
│dev │      │ prod │            │dev │      │ prod │
└────┘      └──────┘            └────┘      └──────┘
```

Each Eve instance is fully self-contained. No federation needed.

---

## Cluster Configuration

Clusters are configured at the Eve instance level.

```yaml
# Eve instance config (managed by Eve admins)

clusters:
  default:
    context: dev-cluster

  staging:
    url: https://staging.k8s.internal
    context: staging

  prod:
    url: https://prod.k8s.example.com
    context: production
```

### Project References Clusters

```yaml
# my-project/.eve/environments.yaml

environments:
  staging:
    cluster: staging  # References Eve-managed cluster
    deploy:
      method: kubectl
      manifests: k8s/overlays/staging

  production:
    cluster: prod  # Different cluster
    deploy:
      method: argocd
      app: myapp-prod
```

### Federated Deployments (Topology B)

When production is on a different Eve instance:

```yaml
# my-project/.eve/environments.yaml

environments:
  staging:
    cluster: staging

  production:
    eve: prod-eve     # Route to hardened Eve instance
    cluster: prod
    approval:
      required: true
```

The CLI handles federation transparently:

```bash
# This routes to prod-eve automatically
eve deploy production --project proj_myapp --version v1.2.4

# Explicitly target an Eve instance
eve --instance prod-eve deployment list --project proj_myapp
```

### CLI Commands

```bash
# List clusters on current Eve instance
eve cluster list

# Show cluster details
eve cluster show prod

# Which projects deploy to a cluster?
eve cluster projects prod

# List configured Eve instances (for federation)
eve instance list

# Switch default instance
eve instance use prod-eve
```

---

## RBAC

Permissions are scoped to **project + environment**.

### Permission Model

```yaml
# Eve instance RBAC config

roles:
  project-developer:
    # Per-project permissions
    permissions:
      - project.read
      - job.create
      - job.read
      - deployment.read

  project-deployer:
    permissions:
      - project.read
      - job.create
      - job.read
      - deployment.create
      - deployment.approve  # For non-prod
      - deployment.read

  project-admin:
    permissions:
      - project.*
      - job.*
      - deployment.*

# Role assignments
assignments:
  - user: @alice
    project: proj_myapp
    role: project-admin

  - team: backend-team
    project: proj_myapp
    role: project-deployer

  - team: backend-team
    project: proj_api
    role: project-developer
```

### Environment-Level Restrictions

```yaml
# my-project/.eve/environments.yaml

environments:
  production:
    approval:
      required: true
      approvers:
        - user: @alice       # Only these users can approve
        - team: myapp-leads
```

---

## Audit Log

All actions are logged with project context.

### CLI Commands

```bash
# Audit log for a project
eve audit list --project proj_myapp
eve audit list --project proj_myapp --env production
eve audit list --project proj_myapp --actor @alice
eve audit list --project proj_myapp --since 2026-01-01

# Show event details
eve audit show evt_xxx --project proj_myapp

# Export
eve audit export --project proj_myapp --format json > audit.json

# Cross-project audit (admin)
eve audit list --all --action deployment.approve
```

### Example Audit Trail

```
eve audit list --project proj_myapp --env production

TIMESTAMP            ACTOR           ACTION                TARGET                RESULT
───────────────────────────────────────────────────────────────────────────────────────
2026-01-17 10:00:00  pipeline/dp-1   deployment.create     dep_abc123            pending
2026-01-17 10:15:00  user/@bob       deployment.approve    dep_abc123            success
2026-01-17 10:15:01  pipeline/dp-1   deployment.start      dep_abc123            success
2026-01-17 10:17:00  pipeline/dp-1   deployment.complete   dep_abc123            success
2026-01-17 10:18:00  job/job_xyz     job.run               smoke-tests           success
2026-01-17 10:18:01  pipeline/dp-1   pipeline.complete     run_abc123            success
```

---

## Example: Complete Flow

```
Project: proj_myapp (My App)

1. Developer pushes to main branch

2. Pipeline "deploy-to-prod" triggers:

   eve pipeline run deploy-to-prod --project proj_myapp --trigger push --ref main

3. Stage: deploy-staging

   eve deploy staging --project proj_myapp --version abc123 --wait
   # Deploys to example-cluster, waits for healthy

4. Stage: e2e-tests

   eve job create --project proj_myapp --env staging --run "pnpm test:e2e"
   # Creates job, waits for completion
   # Job result: 47/47 tests passed

5. Stage: deploy-prod (triggers approval)

   eve deploy production --project proj_myapp --version abc123
   # Output:
   #   Project: proj_myapp
   #   Deployment dep_xyz created (pending approval)
   #   Target: production (cluster: prod-cluster)
   #   Awaiting approval from: [myapp-leads, @alice]

   # @alice approves:
   eve deployment approve dep_xyz --project proj_myapp --reason "LGTM"

   # Deployment proceeds to prod-cluster

6. Stage: smoke-tests

   eve job create --project proj_myapp --env production --run "pnpm test:smoke"
   # Job result: all passed

7. Pipeline complete

   eve audit list --project proj_myapp --pipeline-run run_xxx
   # Full audit trail available
```

---

## CLI Summary

All commands are project-scoped.

### Global Flags
```bash
--project <id>                         # Required for most commands
--cluster <name>                       # Target specific cluster (admin)
--json                                 # Output as JSON
```

### Environment Commands
```bash
eve env list --project <id>            # List project environments
eve env show <name> --project <id>     # Show environment details
eve env show <id> <name>   # Get current status
```

### Deployment Commands
```bash
eve deploy <env> --project <id> --version <v>
eve deployment list --project <id>
eve deployment show <dep-id> --project <id>
eve deployment approve <dep-id> --project <id>
eve deployment reject <dep-id> --project <id>
eve deployment rollback <env> --project <id>
eve deployment history <env> --project <id>
```

### Pipeline Commands
```bash
eve pipeline list --project <id>
eve pipeline show <name> --project <id>
eve pipeline run <name> --project <id>
eve pipeline status <run-id> --project <id>
eve pipeline runs --project <id>
eve pipeline logs <run-id> --project <id>
eve pipeline cancel <run-id> --project <id>
```

### Audit Commands
```bash
eve audit list --project <id>
eve audit show <evt-id> --project <id>
eve audit export --project <id>
```

### Cluster Commands (Admin)
```bash
eve cluster list
eve cluster show <name>
eve cluster projects <name>
```

### Instance Commands (Federation)
```bash
eve instance list                      # List configured Eve instances
eve instance show <name>               # Show instance details
eve instance use <name>                # Set default instance
eve --instance <name> <command>        # Run command against specific instance
```

---

## Agent Skills

With all CD functions exposed via CLI, agent skills can orchestrate deployments:

```typescript
// Example: Agent deploy skill

async function deployToProduction(projectId: string, version: string) {
  // Deploy to staging first
  await eve(`deploy staging --project ${projectId} --version ${version} --wait`);

  // Run e2e tests
  const testJob = await eve(`job create --project ${projectId} --env staging --run "pnpm test:e2e"`);
  const result = await eve(`job wait ${testJob.id} --project ${projectId}`);

  if (!result.success) {
    return { success: false, reason: 'Staging e2e tests failed' };
  }

  // Deploy to production (will require approval)
  const deployment = await eve(`deploy production --project ${projectId} --version ${version}`);

  // Wait for approval and completion
  await eve(`deployment wait ${deployment.id} --project ${projectId}`);

  // Run smoke tests
  const smokeJob = await eve(`job create --project ${projectId} --env production --run "pnpm test:smoke"`);
  const smokeResult = await eve(`job wait ${smokeJob.id} --project ${projectId}`);

  if (!smokeResult.success) {
    await eve(`deployment rollback production --project ${projectId}`);
    return { success: false, reason: 'Smoke tests failed, rolled back' };
  }

  return { success: true };
}
```

---

## Implementation Checklist

### Phase 1: Environments & Clusters
- [ ] `eve env` CLI commands (project-scoped)
- [ ] `eve cluster` CLI commands
- [ ] `.eve/environments.yaml` parser
- [ ] Environment status tracking per project
- [ ] Cluster reference resolution

### Phase 2: Deployments
- [ ] `eve deploy` CLI commands (project-scoped)
- [ ] `eve deployment` CLI commands
- [ ] Deploy method adapters (kubectl, argocd, helm)
- [ ] Approval flow for protected environments
- [ ] Rollback support

### Phase 3: Pipelines
- [ ] `eve pipeline` CLI commands (project-scoped)
- [ ] `.eve/pipelines.yaml` parser
- [ ] Pipeline execution engine
- [ ] Trigger handlers (push, pr_merged, etc.)

### Phase 4: RBAC
- [ ] Project + environment scoped permissions
- [ ] Role assignments
- [ ] Permission checking in API

### Phase 5: Federation (Topology B)
- [ ] `eve instance` CLI commands
- [ ] Multi-instance config (`~/.eve/config.yaml`)
- [ ] Cross-instance API calls
- [ ] Federated auth tokens
- [ ] Environment routing to remote Eve instances

### Phase 6: Audit
- [ ] `eve audit` CLI commands (project-scoped)
- [ ] Audit event storage
- [ ] Query/filter capabilities
- [ ] Cross-instance audit aggregation

### Phase 7: Skills
- [ ] Document skill patterns for CD
- [ ] Build example deploy skill

---

## See Also

- [Runtime Core Design](./runtime-core-design.md) - Runtime architecture and services
- [Integration Testing Strategy](./integration-testing-strategy.md) - Testing modes
- [Integration Testing Strategy](./integration-testing-strategy.md) - Testing approach

# System Documentation

Authoritative docs describing how Eve Horizon works today. Each doc includes **Current (Implemented)** and **Planned (Not Implemented)** sections so readers can distinguish reality from intent.

## Start Here

- **[System Overview](./system-overview.md)** - Visual introduction with architecture diagrams. Point people here first.
- **[Agent-Native Design Guide](../ideas/agent-native-design.md)** - Non-Eve, generic principles that inform the platform.

## Supporting Repos

- **Skillpacks**: https://github.com/eve-horizon/eve-skillpacks
- **Fullstack Example**: https://github.com/eve-horizon/eve-horizon-fullstack-example

## Template

- [System Doc Template](./template.md)

## Architecture & Concepts

- [Unified Architecture](./unified-architecture.md)
- [Agents & Teams](./agents.md)
- [Threads](./threads.md)
- [Chat Routing](./chat-routing.md)
- [Embedded App Conversations](./eve-sdk.md#embedded-conversation-pane)
- [Integrations](./integrations.md)
- [Events (Event Spine)](./events.md)
- [Cross-Project App Links](./cross-project-app-links.md)
- [Local App-Link Mesh](./local-app-link-mesh.md)
- [Orchestrator](./orchestrator.md)
- [Builds](./builds.md)
- [Pipelines](./pipelines.md)
- [Workflows](./workflows.md)
- [Eve Manifest](./manifest.md)
- [Configuration Model (Current)](./configuration-model-refactor.md)
- [Extension Points](./extension-points.md)
- [Worker Types](./worker-types.md)
- [Org Analytics](./analytics.md)

## Storage & Data

- [Object Store & Org Filesystem](./object-store-and-org-filesystem.md)

## Ops & Runtime

- [Deployment](./deployment.md)
- [Container Registry](./container-registry.md)
- [K8s Local Stack](./k8s-local-stack.md)
- [Observability](./observability.md)
- [Pricing & Billing](./pricing-and-billing.md)
- [Agent Runtime](./agent-runtime.md)
- [Chat Gateway](./chat-gateway.md)

## Security & Auth

- [Auth & Governance](./auth.md)
- [Identity Providers](./identity-providers.md)
- [App Service Eve API Access (Current)](./app-service-eve-api-access.md)
- [Agent App API Access](./agent-app-api-access.md)
- [Eve SDK (App Developer Entry Point)](./eve-sdk.md)
- [Eve Auth SDK (System Reference)](./eve-auth-sdk.md)
- [App SSO Integration (Quick Start)](./app-sso-integration.md)

## API & Contracts

- [API Philosophy](./api-philosophy.md)
- [Job API](./job-api.md)
- [Job Git Controls](./job-git-controls.md)
- [Job Context](./job-context.md)
- [Job Control Signals](./job-control-signals.md)
- [Workflow Invocation](./workflow-invocation.md)
- [OpenAPI (Guide)](./openapi.md)
- [OpenAPI JSON](./openapi.json)
- [OpenAPI YAML](./openapi.yaml)


## Execution & Skills

- [Skills System](./skills.md)
- [Skills Manifest](./skills-manifest.md)
- [Skill-Based Workflows](./skills-workflows.md)
- [Orchestration Skill](./orchestration-skill.md)
- [Agent Harness Design](./agent-harness-design.md)
- [Harness Adapters](./harness-adapters.md)
- [Harness Policy and Reasoning Controls](./harness-policy.md)


## Ops & Tooling

- [Job CLI Reference](./job-cli.md) - Complete job command reference
- [Database CLI + Managed DB](./db.md)
- [CLI Debugging Guide](./cli-debugging.md) - Debug jobs and system state via CLI
- [CLI Tools and Credentials](./cli-tools-and-credentials.md)
- [Secrets](./secrets.md)

## Maintenance Rules

- Update this index whenever a system doc is added, renamed, or removed.
- Keep “Current” and “Planned” sections accurate; remove legacy workflow references.
- Prefer updating system docs over duplicating content in plans or AGENTS.md.

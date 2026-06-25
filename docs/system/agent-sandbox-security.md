# Agent Sandbox Security

> Status: Current
> Last Updated: 2026-01-21
> Purpose: Document the security model for agent CLI sandboxing in shared worker environments.

## Overview

When multiple organizations or projects share the same worker infrastructure, agent CLI processes must be sandboxed to prevent:
- Directory traversal attacks accessing other workspaces
- Unauthorized access to worker configuration or secrets
- Cross-job data leakage

Eve Horizon implements a multi-layer security model combining CLI-level sandboxing with container isolation.

## Threat Model

### Attacker Capabilities
- Malicious code in a repository executed by an agent
- Prompt injection causing agent to attempt unauthorized actions
- Agent attempting to access files outside designated workspace

### Protected Assets
- Other project workspaces on shared workers
- Worker configuration and credentials
- Host system files and environment

## Sandbox Implementation

### Layer 1: CLI-Level Sandboxing

Each harness adapter configures sandbox flags specific to its CLI tool:

#### Claude / mclaude / zai
```bash
claude --add-dir <workspace> ...
```
- `--add-dir` restricts tool access to specified directory
- Agent file operations confined to workspace only

#### code / codex (OpenAI)
```bash
codex --sandbox workspace-write -C <workspace> ...
```
- `--sandbox workspace-write` restricts all writes to workspace
- `-C` sets the working root directory

#### gemini
```bash
gemini --sandbox ...
```
- `--sandbox` flag enables sandbox mode

### Layer 2: Process Isolation

- Working directory (`cwd`) set to workspace root
- Environment variables sanitized
- Config directories isolated per-job at `{workspace}/.agent/harnesses/{harness}`

### Layer 3: Container Isolation (K8s Runner Pods)

For production deployments using Kubernetes runner pods:
- Each job executes in an isolated container
- Network policies restrict pod communication
- Resource limits prevent DoS attacks
- Ephemeral storage destroyed after job completion

## Configuration

Sandboxing is automatic and requires no configuration. The `eve-agent-cli` package applies sandbox flags based on detected harness type.

### Harness Sandbox Flags

| Harness | Sandbox Flag | Behavior |
|---------|-------------|----------|
| claude | `--add-dir <workspace>` | Tool access restricted to workspace |
| mclaude | `--add-dir <workspace>` | Tool access restricted to workspace |
| zai | `--add-dir <workspace>` | Tool access restricted to workspace |
| code | `--sandbox workspace-write` | Writes restricted to workspace |
| codex | `--sandbox workspace-write` | Writes restricted to workspace |
| gemini | `--sandbox` | Sandbox mode enabled |

## Workspace Layout (Security Perspective)

```
/workspaces/{projectId}/{jobId}/{attemptNum}/
  repo/                  # Cloned repository (sandbox root)
    .eve/
      secrets/           # Job-specific secrets (interpolated)
    .agent/
      harnesses/         # Per-harness config directories
        mclaude/
        zai/
```

Each job has a unique workspace path. Sandboxing prevents traversal to:
- `/workspaces/{otherProjectId}/` - Other projects
- `/workspaces/{projectId}/{otherJobId}/` - Other jobs in same project
- Parent directories containing worker infrastructure

## Limitations

### Bash Command Execution

CLI sandboxes primarily restrict file system tools (Read, Write, Edit, Glob, etc.). The Bash tool can execute arbitrary commands which may bypass file restrictions.

Mitigations:
1. **Container isolation**: Runner pods provide syscall-level isolation
2. **Permission policies**: `default` mode requires human approval for risky commands
3. **Network isolation**: Pods cannot access other workspaces via network

### Defense in Depth

For high-security deployments:
1. Use dedicated runner pods (not shared workers)
2. Apply restrictive permission policies (`default` or `auto_edit`)
3. Enable network policies to limit pod egress
4. Mount workspaces as read-only where possible

## Testing Sandbox Effectiveness

Verify sandboxing by testing these scenarios:
1. Attempt to read `/etc/passwd` - should fail
2. Attempt to write outside workspace - should fail
3. Attempt to traverse `../../../` - should fail

## Related Documents

- [agent-harness-design.md](./agent-harness-design.md) - Harness invocation semantics
- [unified-architecture.md](./unified-architecture.md) - System architecture overview
- [worker-types.md](./worker-types.md) - Worker deployment modes

# Packages Architecture

> **What**: Shared libraries used across apps and tooling.
> **Why**: Keeps cross-cutting code centralized and prevents service-to-service coupling.

## Overview

Packages hold reusable code (types, database, CLI). Apps depend on packages; packages do not depend on apps.
This keeps layering clean and allows shared logic to evolve without circular dependencies.

## Key Decisions (Why)

- **Strict layering**: apps -> packages, not the other way around.
- **Shared types**: consistent contracts across services and CLI.

## Navigation

- CLI: [cli/ARCHITECTURE.md](./cli/ARCHITECTURE.md) — `@eve-horizon/cli`, the `eve` command
- DB: [db/ARCHITECTURE.md](./db/ARCHITECTURE.md) — queries + migrations
- Shared: [shared/ARCHITECTURE.md](./shared/ARCHITECTURE.md) — schemas, invoke, harnesses, pricing
- Agent CLI: [eve-agent-cli/ARCHITECTURE.md](./eve-agent-cli/ARCHITECTURE.md) — uniform harness invocation
- Auth SDKs: `auth/` + `auth-react/` — app SSO SDK (`@eve-horizon/auth`, `@eve-horizon/auth-react`)
- Chat SDKs: `chat/` + `chat-react/` — embedded chat SDK (`@eve-horizon/chat`, `@eve-horizon/chat-react`)
- Migrate: `migrate/` — standalone migration runner image (`@eve-horizon/migrate`)
- Skillpacks repo: https://github.com/eve-horizon/eve-skillpacks

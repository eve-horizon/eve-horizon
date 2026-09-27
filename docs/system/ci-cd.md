# CI/CD

GitHub Actions workflows for this repo: continuous integration, and the
tag-driven publishing of every release artifact.

> **Canonical repo**: `github.com/eve-horizon/eve-horizon`. Releases are cut here
> and nowhere else. See [OSS Release Cutover](../deploy/oss-release-cutover.md).

## The one rule

**A release tag publishes artifacts. It never deploys.**

This repo builds images and npm packages. Rolling those into a cluster is done
from a *deployment instance repo* by its owner. No workflow here may hold
cluster credentials or use `repository_dispatch` to reach an instance repo — see
[deployment.md](./deployment.md) for the three-repo model.

## Image workflows

| Trigger | Workflow | Result |
| --- | --- | --- |
| PR or main push | `image-build-check.yml` | Builds all seven services and six toolchains without credentials; native source browser smoke |
| `toolchain-images/v*` | `toolchain-images.yml` | Six independently versioned AMD64 GHCR images after archive and native gate |
| `release-v*` | `publish-images.yml` | Seven AMD64 GHCR service images after archive and native gate |
| manual dispatch | either image publisher | Build and native gate only; no publication |

Every publisher uses per-image immutable Docker archives and receipts. A single
native gate tests frozen runtime/toolchain inputs, then a global prepublish job
checks that all version tags are unused. Publisher jobs alone have
`packages: write`. They load and verify the archived image and compare its
local config digest to the pushed registry config digest. There are no
floating release tags and no AWS mutation or rollout coupling. See
[Container Image Release](../deploy/container-image-release.md) for release
order, public package visibility, anonymous digest verification, and owner
rollout receipts.

Toolchain version is read from `docker/toolchains/release-version.txt`; a
toolchain tag must match it. A service release resolves the declared Python
and browser toolchains at that version to digests before the browser gate.
First supported platform: linux/amd64.

Other tag publishers remain `cli-v*`, `sdk-v*`, and `chat-v*` for npm.
The retired `worker-images/v*` and `eve-migrate/v*` paths stay retired.

## npm packages — the version comes from the tag

`publish-cli`, `publish-sdk` and `publish-chat` all derive the version from the
tag and run `npm version <tag-version>` before publishing. **The `version` field
in `package.json` is ignored**, so the in-repo values drift and are not a
reliable guide to what is published.

Always check npm before tagging. As of 2026-08-25:

| Package | Published | In repo | Next tag must be ≥ |
| --- | --- | --- | --- |
| `@eve-horizon/cli` | `0.2.73` | 0.2.44 | `cli-v0.2.74` |
| `@eve-horizon/auth` + `auth-react` | `0.1.5` | 0.0.1 | `sdk-v0.1.6` |
| `@eve-horizon/chat` + `chat-react` | `0.0.2` | 0.0.1 | `chat-v0.0.3` |

`@eve-horizon/cli@0.2.71` was the first npm release published from the OSS repo.
The current `0.2.73` release was published there on 2026-08-25. `auth`/`chat` are still on
their private-repo versions — the first `sdk-v*`/`chat-v*` tag will be their
first OSS publish.

```bash
npm view @eve-horizon/cli version    # before choosing a tag
```

Tagging a version that already exists fails the publish. Tagging a *lower*
unused version succeeds but moves the npm `latest` dist-tag backwards for every
consumer — worse than a failure, because it's silent.

Publish config was verified on all five packages: none is `private`, each has
`files` and `license: MIT`, and each publishes with `--access public`.

## Installing a published CLI

```bash
npm install -g @eve-horizon/cli            # latest
npm install -g @eve-horizon/cli@0.2.36     # pinned
```

There is also a `/cli-publish-and-install` skill for manual publishing when CI
is unavailable.

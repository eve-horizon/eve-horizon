# Contributing to Eve Horizon

Thanks for your interest in contributing! This guide covers local setup, the
test tiers, and how to get a change merged.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it.

## Developer Certificate of Origin (DCO)

Contributions are accepted under the [DCO](https://developercertificate.org/).
Sign off every commit to certify you wrote the patch or otherwise have the right
to submit it under the project's MIT license:

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. PRs whose
commits are not signed off may be asked to amend.

## Local setup

Prerequisites: Docker Desktop (8GB+, 4+ CPUs), Node.js >= 22, pnpm >= 9.

```bash
pnpm install            # install workspace
pnpm build              # build all packages
pnpm test               # unit tests
```

For a full local runtime, the quickest path is Docker Compose:

```bash
./bin/eh start docker   # brings up the stack; API at http://localhost:4801
```

See the [README](README.md) and `docs/` for the k3d (Kubernetes) path and the
deployment model.

## Test tiers

| Tier | What | How |
| --- | --- | --- |
| Unit | Pure logic | `pnpm test` |
| Integration | API, jobs, secrets (hits the API, not the DB) | `./bin/eh test integration` |
| Manual | Happy paths on a real stack | see `tests/manual/` |

Please run the relevant tiers before opening a PR. New behavior should come with
tests.

## Pull requests

1. Fork and branch from `main`.
2. Keep changes focused; match the style and conventions of the surrounding code.
3. Ensure `pnpm build` and `pnpm test` pass; sign off your commits (DCO).
4. Open a PR describing the change and how you verified it. Fill in the PR
   template checklist.
5. A maintainer will review. CI (build, tests, license check) must be green.

## Reporting bugs / requesting features

Use the GitHub issue templates. For security issues, **do not** open a public
issue — follow [SECURITY.md](SECURITY.md).

# Browser runtime packaging for verification jobs

> Date: 2026-09-25
> Status: Proposed; subject to the feasibility gate in the
> [implementation plan](../../docs/plans/supported-headless-chromium-runtime-plan.md)
> Source: [GitHub issue #6](https://github.com/eve-horizon/eve-horizon/issues/6)

## Decision

Offer headless Chromium as a declared `browser` toolchain, composed with the
existing `python` toolchain for the reported Playwright job. Bundle the pinned
Python Playwright 1.63.0 client with its matching browser and expose a stable
absolute wrapper that selects both. The first release targets linux/amd64,
the architecture currently published for platform service images. Publish
the browser payload separately from the platform worker image. Verify a real
launch under both worker and agent-runtime security contexts before treating
this choice as final.

If the browser and its dependency closure cannot run reliably from the
extracted toolchain, place only the required OS packages in both runtime base
images and keep the browser executable in the declared toolchain. Record the
measured failure and final package set here when U1 resolves the branch.

## Rationale

The current public runtime uses one worker image and independently versioned,
on-demand toolchains. Agent jobs execute in `agent-runtime`, so a worker-only
image variant would leave a promised path broken. A declaration makes the
browser requirement explicit, allows the platform to fail setup early, and
avoids per-job privileged package installation. The browser payload and
Playwright package must be version matched.

## Constraints

- Keep existing non-root, seccomp, and privilege settings.
- Provide the browser payload's source-image digest and probed
  browser/Playwright versions for verification receipts. The shared cache is
  writable to the runtime user, so the source digest is provenance rather than
  tamper-proof attestation of extracted files.
- Treat missing or incompatible browser runtime as setup failure.
- Have the AWS registry owner provision a new browser repository through the
  authoritative deployment instance Terraform; publishing workflows verify
  repository existence without creating it.
- Publish and roll out through the existing toolchain and deployment-instance
  contracts; make no direct AWS infrastructure changes.

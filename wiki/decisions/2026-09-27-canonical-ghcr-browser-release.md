# Canonical GHCR browser release

> Date: 2026-09-27 · Status: release preparation; publication and hosted proof pending

The prior service and toolchain workflows published to public ECR and could
create repositories outside the owning Terraform. Legacy ECR ownership is
unconfirmed. Use repository-linked packages under
`ghcr.io/eve-horizon/eve-horizon` for the next browser release. Preserve the
historical ECR `release-v0.1.314` record; do not treat it as GHCR proof.

Toolchains have a source-controlled independent version. The first supported
release is AMD64 only. A tag may publish only after all image builds and a
native worker/agent Chromium launch on the exact frozen inputs. Build and
publisher jobs exchange immutable Docker archives with identity and SHA-256
receipts. Publisher jobs alone receive `packages: write`, and they push the
same archives after global gate and absent-version checks. Source-linked OCI
labels are added at build time before the first package publication.

The standard x64 hosted runner has 14 GB storage. Per-image build/publish jobs
avoid holding the full release set at once. The native gate holds two runtime
and two toolchain images; its disk use must be measured on the first run. No
published or hosted success is asserted by this source decision. Newly created
GHCR packages may be private, so an owner must make them public and check
anonymous digest reads before rollout. A deployment instance owner controls
its own digest-pinned rollout. U4a implements source preparation; U4b retains
native publication, visibility, rollout, hosted BR-08, and issue closure.

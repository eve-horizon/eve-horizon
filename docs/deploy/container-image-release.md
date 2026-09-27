# Canonical GHCR image release

This is the release procedure for the canonical source repository. The seven
service packages live at `ghcr.io/eve-horizon/eve-horizon/{api,sso,gateway,agent-runtime,orchestrator,worker,dashboard}`. The six independent toolchain
packages are named `toolchain-{python,media,rust,java,kotlin,browser}` under
the same prefix. This repository publishes images; deployment owners roll out
specific digests from their instance repositories.

## Release order and gates

1. Review source, the browser decision, `bash scripts/release/check.sh`,
   `pnpm build`, `pnpm test`, and `./bin/eh test integration`. Green source
   checks do not prove the native browser gate or hosted availability.
2. Set `docker/toolchains/release-version.txt` to the approved independent
   toolchain version, currently `0.1.0`. Push only the approved
   `refs/tags/toolchain-images/v<version>` ref. A dispatch runs the same build
   and gate but cannot publish. All six build jobs produce one linux/amd64
   Docker archive plus SHA-256, image ID, source revision and version receipt.
   The native gate loads the exact Python/browser archives, builds worker
   `base` and agent-runtime `production` from that source, and launches the
   bundled Playwright client and Chromium under UID/GID 1000, default seccomp,
   no new privileges, and no capabilities. The probe asserts text, SVG geometry,
   nonempty screenshot, versions, and no cgroup OOM kill at worker 3 GiB and
   agent-runtime 2 GiB. Gate logs are Actions artifacts for 30 days.
3. Only after every build and the native gate pass, `prepublish` checks all six
   version tags are absent. Publisher jobs load their same immutable archives,
   recheck SHA and image/config identity, and push only the versioned tag. No
   release path creates AWS infrastructure or triggers a deployment.
4. Make the six GitHub packages **public** in package settings. A public
   source repository alone does not make its GHCR packages public. Check each
   anonymous digest read from a clean machine/session. Capture package URL,
   tag, manifest digest, config digest, source revision, and gate run ID. If
   a package is private or an anonymous pull fails, stop before service release.
5. Push one approved `refs/tags/release-v<version>` ref. Service builds archive
   all seven exact AMD64 images. The native gate loads the frozen worker and
   agent-runtime images and pulls the declared versioned Python/browser images
   from `release-version.txt`, resolving their registry digests before the
   launch. `prepublish` rejects any existing service version tag. Publishers
   load, verify and push exactly their archived images. No `latest`, `staging`,
   or SHA alias is part of release qualification.
6. Make all seven new packages public as needed, then anonymously pull each
   `@sha256:` digest and inspect source/revision labels and linux/amd64
   platform. Record the registry manifest digest separately from the Docker
   config digest (local image ID). The publisher checks they agree on config
   identity; a registry manifest is a different object from a local image ID.
7. The deployment instance owner pins those service and toolchain **digests**,
   reviews their instance Terraform/manifests, performs the rollout there, and
   records deployment revision, actual pulled imageIDs, job IDs, browser
   versions, DOM/SVG result, and screenshot SHA-256. Hosted BR-08 and capacity
   checks occur only after that rollout. Attach those receipts to issue #6.

Use `git push origin refs/tags/<single-approved-tag>`; never `git push --tags`.
A partial publish cannot be safely rerun on the same version because any
existing tag causes a fail-closed stop. Resolve the partial release explicitly
and choose a new version; never overwrite an existing version.

## Capacity and provenance

Builds and publishers are per-image jobs on native GitHub `ubuntu-24.04` x64
runners. The native gate downloads only two runtime and two toolchain archives,
which bounds each job's Docker storage. The largest observed local compressed
worker archive is about 2.1 GB, agent-runtime about 1.86 GB; each runner must
also hold loaded layers and Buildx intermediate layers. If a standard runner's
14 GB disk is insufficient, select a larger native x64 runner after measuring
usage. Do not prune an operator's local Docker daemon to make this fit.

Each archive has a SHA-256 receipt and exact local image ID; GitHub Actions v4
artifacts are immutable within the run. The publisher verifies the archive
hash, loaded ID, OCI source/revision/version labels, platform, and the pushed
manifest's config digest. The browser probe derivative copies only extracted
payloads into the exact runtime base; it does not rebuild those bases after
qualification. Registry source digests describe input provenance. A writable
runtime toolchain cache is not tamper-proof attestation of executed files.

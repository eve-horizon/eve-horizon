# Browser runtime packaging for verification jobs

> Date: 2026-09-25
> Status: Rosetta linux/amd64 launch passed; native hardware and pod checks remain subject to the
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

The extracted payload currently contains the matching client, headless shell,
fonts, and the browser's resolved ELF libraries. Keep the self-contained
candidate for a native linux/amd64 launch check. Do not add packages to both
runtime base images based on the arm64 host's amd64 emulator failure: its
stack trace is in QEMU, and both images report complete ELF resolution with
the payload library path. If the native check finds a missing runtime
dependency, add only the measured package set to both base images and update
this record before release.

## U1 feasibility evidence (2026-09-25)

The exact `apps/worker/Dockerfile` and `apps/agent-runtime/Dockerfile`
`production` targets built for linux/amd64. The extracted browser and Python
toolchains were copied into each unmodified production image for the smoke
test. The test ran as UID/GID 1000 with Docker's default seccomp profile,
`no-new-privileges`, and all capabilities dropped. No privileged or root
browser run was used.

| Artifact | Local image ID (sha256) | Uncompressed image size |
| --- | --- | ---: |
| `toolchain-browser:local` | `1231f585849dee3c2289e5b7b3ca39e665f4132331e713a677a0b0d363eb98d5` | 203,868,942 bytes |
| `worker:browser-test` | `5373a7e363b70f5652d03753ba16d11ccbd6f05aadf7a23a28f06f58eee98847` | 3,353,264,782 bytes |
| `agent-runtime:browser-test` | `f84f1d64a6e5c879b709c63d5cb9176bbaad664c1b3d05b0b2c046e1024a4a3b` | 1,850,322,886 bytes |

The browser payload occupies 481,632 KiB when extracted, including 57 copied
ELF library files. The absolute wrapper imported Playwright **1.63.0** from
that payload; the bundled headless shell printed **Google Chrome for Testing
153.0.8010.12**. `ldd` with the wrapper's `LD_LIBRARY_PATH` reported no
missing libraries for the shell in either runtime image. Bundled `fc-match`
resolved **Liberation Sans** from the extracted font tree in both images.
The smoke uses the
same absolute wrapper to launch and render a tiny HTML/SVG page, check text
and rectangle geometry, and save a screenshot.

The launch did **not** pass on this machine. Its Colima VM is arm64 and ran the
amd64 images through QEMU. In both runtime images, Chromium aborted before
rendering with `Assertion failed: p_rcu_reader->depth != 0
(/qemu/include/qemu/rcu.h: rcu_read_unlock: 102)`. This is emulator failure
evidence, not native linux/amd64 acceptance. Chromium font rendering, profile writes,
Chromium memory peak, and screenshot storage could not be measured from a
successful run. The command line showed a distinct writable `/tmp`
`playwright_chromiumdev_profile-*` path in each attempt, but Chromium aborted
before the profile check. A native amd64 worker and agent-runtime run of
`docker/toolchains/browser/test-runtime.sh` remains mandatory for BR-01.

The first exact worker image build also killed a 2 GiB / 2 CPU Colima daemon
with a Buildx RPC EOF. Restarting Colima at 4 GiB / 4 CPUs allowed both exact
production images to build. This is **build-host** capacity evidence, not a
runtime pod memory requirement. The existing runtime resource limits still
need a successful native browser launch and local pod measurements.

These IDs identify local image builds. A published source-image digest and
deployed runtime image digests must be recorded after release; the writable
toolchain cache makes source digest provenance rather than tamper-proof
attestation of extracted files.

## Follow-up launch evidence (2026-09-25)

An isolated Colima VZ+Rosetta amd64 profile (`colima-browser-rosetta`, 4 GiB
RAM, 4 CPUs, 40 GiB disk) ran the mandatory `test-runtime.sh` smoke with
exit 0 in both exact production image builds. The default Docker context
remained `colima`. Probe derivatives added only two layers, retaining each
original production image's DiffID prefix. The runtime user was UID/GID 1000,
with Docker's default seccomp, no-new-privileges, all capabilities dropped,
and a writable `/tmp` tmpfs. The wrapper reported Playwright 1.63.0 and
Chromium 153.0.8010.12; fontconfig found Liberation Sans. The synthetic SVG
rectangle measured 40 × 20 and the screenshot was 6,003 bytes with SHA-256
`68f09a43c4e7beb79ebea5f139faed51cdd8686680cabc2da70a77e3faae4c0d`.
Worker memory peak was 566,427,648 bytes; agent-runtime peak was 455,168,000
bytes. Qualification receipt: `/private/tmp/eve-browser-u1-qualification.json`,
SHA-256 `6ead227b8fda8c4d05c95d118996a90e54b29c764b9165caa4e61d10033bd966`.

This proves amd64 image execution under Rosetta, not launch on native amd64
hardware or under a Kubernetes pod. Native hardware, pod capacity, and
concurrent isolation remain release gates. The self-contained payload remains
the selected candidate; no base-image OS package fallback is justified by the
evidence so far.

Inline runtime metadata reads the service image digest from
`EVE_RUNTIME_IMAGE_DIGEST`; deployment instances must inject the published
digest and assert that it matches the running worker and agent-runtime image
for BR-07. Source code cannot infer the orchestrator's deployed image digest.
Runner metadata instead records each init container's observed Kubernetes
`imageID` after its image has been pulled.

Script jobs continue to execute inline by default. Setting
`EVE_SCRIPT_K8S_RUNNER=true` on a Kubernetes worker opts script jobs into a
dedicated runner pod. The worker submits the same job to the pod's
`/scripts/execute` route; the pod carries `EVE_RUNNER_SELF_TERMINATE=1` to
prevent redispatch. The pod emits the terminal runner event after execution;
the outer worker emits `runner.failed` only if setup fails before a
terminal pod event. Both runner paths retain the pulled init-container
`imageID` when later toolchain metadata is written.

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

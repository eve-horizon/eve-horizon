# Supported headless Chromium runtime for jobs

> Status: Proposed implementation and verification plan
> Date: 2026-09-25
> Source: [GitHub issue #6](https://github.com/eve-horizon/eve-horizon/issues/6)
> Planning base: `cf2ad69a649635fa14535cbe65c769638fb4099b`

## Problem and boundary

The reported job declares `toolchains: [python]`, installs
`playwright==1.63.0` and its Chromium browser, then fails to launch Chromium
because `libatk-1.0.so.0` is absent. Package and browser installation success
is not browser verification. The issue does not establish the deployed image
revision; record that revision before attributing the live failure to this
source tree.

The supported result is a declared, versioned browser capability that a job
can use to render HTML/SVG, inspect text and geometry, and save screenshots
without privileged package installation or copying system libraries into each
project. Script steps run on `worker`; agent steps run on `agent-runtime`.
Both paths must work. The current public artifact model uses one worker image
and separate on-demand toolchains, not published worker image variants
([worker types](../system/worker-types.md)).

Classify the missing capability as P1 for this beta: it blocks the promised
browser verification path without a supported workaround. A browser launch
failure is a setup failure, never an HTML-quality result.

### Promised paths and non-goals

- A workflow or pipeline script step declares `toolchains: [python, browser]`
  and runs the platform's pinned Python Playwright client against bundled
  headless Chromium through the documented browser wrapper.
- A workflow agent step declares the same toolchains and can use the same
  documented command from its harness shell.
- Runner-pod execution, where configured, provides the same capability and
  classifies an init-image failure before claiming browser QA.
- Both paths fail visibly when the requested runtime is unavailable.
- The first release supports linux/amd64 headless Chromium with one pinned
  Playwright version. The platform currently publishes service images for
  linux/amd64 only. ARM64, Firefox, WebKit, headed desktops, remote CDP,
  arbitrary Playwright versions, and a general browser service are outside
  this issue.

## Architecture decision and feasibility gate

Start with a `browser` toolchain image. It should hold the Chromium headless
shell, matching browser revision, required ELF libraries, fonts, the pinned
Python Playwright 1.63.0 client, and a small runtime probe beneath
`/toolchain/`. Expose an absolute wrapper such as
`/opt/eve/toolchains/browser/bin/eve-browser-python` that invokes the declared
Python interpreter with the bundled client and browser paths. The wrapper
must preserve the Python toolchain's standard-library path regardless of
declaration order or a login shell resetting `PATH`. The supported job command
uses this wrapper; job-installed Playwright clients and browser downloads are
outside this first release. Pin the client and browser revision together:
[Playwright's browser
documentation](https://playwright.dev/docs/browsers) says each Playwright
version requires specific browser binaries and documents
`PLAYWRIGHT_BROWSERS_PATH` and the headless-only shell option.

The feasibility gate is a real launch, from the extracted payload, inside the
**exact** released worker and agent-runtime image builds under their current
non-root and seccomp settings on linux/amd64. Inspect the dynamic
library closure, font loading, browser profile writes, image size, and pod
memory/ephemeral-storage use. Build the payload against a compatible OS base;
do not assume libraries copied from another distribution work in `node:22-slim`.

If a self-contained payload cannot pass that gate, install the minimal browser
OS dependencies in both runtime base images and retain the versioned browser
binary as the declared toolchain. Record the measured reason for that choice
in the [decision record](../../wiki/decisions/2026-09-25-browser-runtime.md).
Neither branch may add privileged containers, root job commands, a host browser,
or weaker pod security settings. If Chromium cannot launch within that boundary,
stop this beta and make the security/runtime decision explicit.

## Implementation units

Use one controller and a **singleton sequence**. These units share the browser
version and runtime contract, so their independence cannot be proved. Record
the decision in the source-controlled decision record; use Beads for execution
state. No implementation child should be dispatched until the Beads topology,
controller slot, Git base, and resource reservations are proven.

| Unit | Depends on | Owned paths and conflict domain | Acceptance and mandatory evidence | Risk |
| --- | --- | --- | --- | --- |
| U1 — runtime feasibility | none | `docker/toolchains/browser/`, disposable probe files; browser binary/OS ABI | BR-01: bundled client and Chromium launch under UID 1000 in worker and agent-runtime images on amd64, with no missing libraries or security-context changes. Capture client/browser versions, image digest, resource use, and any fallback decision. | High: native libraries, sandbox, image size. |
| U2 — platform contract | U1 | `packages/shared/src/schemas/`, `packages/shared/src/invoke/`, `apps/worker/src/script-executor/`, both `apps/{worker,agent-runtime}/src/invoke/k8s-runner.ts` paths, `apps/agent-runtime/src/invoke/`, `docker/worker/entrypoint.sh`, `bin/eh-commands/k8s-image.sh`, `.github/workflows/toolchain-images.yml`, `.github/workflows/image-build-check.yml`, and both runtime Dockerfiles if U1 chooses the fallback; toolchain declarations, provenance, and setup errors | BR-02, BR-05, and BR-09: declarations resolve in script, agent, and runner jobs; broken payload, failed launch, or failed init image is a setup failure. Run focused schema/provisioning and runner-manifest tests, `pnpm build`, `pnpm test`, and a build-and-launch image smoke. | High: multiple execution paths and shared environment handling. |
| U3 — local scenarios and operator guide | U2 | `tests/manual/scenarios/`, `tests/manual/README.md`, `docs/system/worker-types.md`, manifest/job docs and matching public skillpack reference; local evidence | BR-03, BR-04, BR-06, BR-07, and BR-09 pass on the deployed local stack; scenarios and commands are reproducible. Run affected integration tests and local live jobs. This is the merge gate; hosted BR-08 is not required to integrate this unit. | Medium: real harness behavior and isolation. |
| U4 — release and hosted verification | U3 | Release/deployment records and issue #6; no source-code paths or modifying worker lane | Publish the approved toolchain and service artifacts after release gates, then have the owning deployment instance roll them out. BR-08 passes on that deployment and its evidence is attached to #6 before issue closure. | High: external publication and deployment identity. |

Reserve Docker Buildx capacity and image storage for U1/U2, the local k3d
owner slot and a disposable project for U3, and the registry/deployment-owner
release window for U4. Do not run another image or cluster mutation in those
shared resources concurrently. The controller records each reservation with
its Beads unit before dispatch.

### Contract details for U2

1. Add `browser` to the shared allowed-toolchain schema. Add it to the local
   toolchain build/import/publish list and the independently versioned image
   publishing matrix. Build-only CI must exercise the browser image and its
   launch smoke before a release tag can publish it. Build and publish the
   browser payload for linux/amd64 for this beta; do not advertise the
   existing toolchain matrix's ARM64 output as supported until the service
   images and hard-coded architecture-specific binaries are audited. Keep
   one authoritative Playwright/browser pin in the browser payload and its
   test fixture. Before publishing a new `toolchain-browser` repository, its
   AWS registry owner must provision it through the authoritative deployment
   instance Terraform. Change `toolchain-images.yml` to verify repository
   existence with a read-only call and fail clearly when absent; remove its
   current `aws ecr-public create-repository` path. No workflow from this
   source repo may create AWS infrastructure.
2. Have both inline paths pass the declared toolchain environment to the
   child process. Use the absolute wrapper for the supported browser client;
   it must also work when a login shell resets `PATH`. The wrapper must set
   browser paths from the resolved payload, rather than trusting inherited
   `PLAYWRIGHT_BROWSERS_PATH` or library-path overrides. Reject an
   `env_overrides` attempt to replace the platform browser path, with a
   visible setup error. The runner-pod paths must copy and source the same
   payload, probe it after their final environment is available, and report
   the pulled init image's `imageID`. If an init container cannot pull the
   browser image, classify the pod startup failure as browser setup failure
   rather than waiting for a generic timeout; no main-container probe can run
   in that case.
3. Run a bounded browser probe after provisioning **and final child
   environment assembly**, but before the script or harness starts. Use the
   same wrapper, HOME, working directory, browser profile root, and launch
   options as the child. Test an actual headless launch and tiny page render,
   not only `chromium --version` or `ldd`. A failed probe must return a
   nonzero setup result (`toolchain_unavailable` or a dedicated browser-runtime
   code), with the requested toolchain, image reference, and useful error in
   logs and `runtime_meta`. The worker script path currently catches
   provisioning errors as generic script failures; change it to preserve the
   setup code and metadata as the agent-runtime path does. The job must not
   emit a browser-QA success receipt.
4. Resolve the requested browser image tag to a digest before extraction,
   extract by that digest, and store the **source-image digest** with the
   cached payload. Re-resolve a requested mutable tag on each attempt; if its
   digest differs from the cache marker, refresh the payload before use. On a
   warm hit, report the cached payload's source digest, not a later lookup.
   For runner init containers, record the pulled `imageID` from pod status.
   Record the bundled Playwright and Chromium versions observed by the probe
   plus runtime service image digest alongside that source identity. A QA
   receipt must include the job/attempt ID, these versions, the measured
   DOM/geometry result, and screenshot SHA-256. The toolchain cache is writable
   to the runtime user, so an image digest is **source provenance**, not
   tamper-proof attestation of extracted files. Do not claim otherwise; assess
   cache integrity separately if stronger attestation becomes a requirement.

## Verification matrix

| ID | Check | Passing evidence |
| --- | --- | --- |
| BR-01 | Extracted browser payload and bundled client launch under the released worker and agent-runtime image builds on linux/amd64. | Build logs and real non-root launch output show no missing libraries, with Playwright/Chromium versions and image digests. |
| BR-02 | Manifest validation and expansion accept `browser` for script and agent steps, preserve `python`, and reject unknown toolchains. | Focused schema/expansion tests and resulting `hints.toolchains`. |
| BR-03 | Worker script step uses `python` + `browser`. | `eve job diagnose` shows worker routing and resolved toolchains; the bundled Playwright 1.63.0 client launches, renders synthetic HTML/SVG, asserts exact text and nonzero bounding boxes, and saves a nonempty screenshot. |
| BR-04 | Agent step uses the same capability. | `eve job diagnose` shows agent-runtime routing; the harness runs the same wrapper using its absolute path, and its output contains the measured geometry and screenshot artifact. |
| BR-05 | Missing image, deliberately incompatible bundled client/browser pair, blocked browser-path override, or failed Chromium launch. | Each yields a setup failure with a nonzero attempt result and toolchain diagnostics; no QA-success receipt or screenshot is accepted. |
| BR-06 | Isolation and capacity. | Two simultaneous jobs have distinct writable browser profiles and screenshots; pods retain UID/GID 1000, existing seccomp and privilege settings, and stay within configured memory/storage limits. |
| BR-07 | Reproducible source and observed runtime identity, including a warm cache after a local tag moves. | The payload's stored source-image digest, probed Playwright and Chromium versions, runtime image digest, job/attempt ID, and screenshot SHA-256 agree between job metadata, receipt, and deployed configuration; a moved tag refreshes the cache. |
| BR-08 | Deployed availability. | The script and agent checks pass against the target deployment after its owner rolls out the referenced images, with job IDs and diagnostic output recorded in issue #6. |
| BR-09 | Runner-pod success and init-image failure, if runner execution is enabled. | Runner script and agent paths launch through the same wrapper and record pulled `imageID`; a missing init image terminates as setup failure without a QA-success receipt or generic wait timeout. |

The synthetic fixture should contain a short text node and an SVG rectangle
with explicit dimensions. Assert the text, rectangle bounding-box width and
height, and screenshot file size and hash. This distinguishes rendering from a
browser process that merely starts. Keep the fixture and expected geometry
identical across script and agent checks. Use a disposable project; a missing
image test must use an isolated local configuration rather than changing a
shared deployment's global toolchain tag.

The documented script-step form should be reproducible from a checked-in
fixture, for example:

```yaml
steps:
  - name: browser-script
    toolchains: [python, browser]
    script:
      run: /opt/eve/toolchains/browser/bin/eve-browser-python tests/browser_probe.py
```

The agent-step form declares the same toolchains and instructs the harness to
run that absolute command. `browser_probe.py` should write a machine-readable
receipt and screenshot into the job workspace. Inspect those files and job
logs directly; an agent's prose claim of success is not acceptance evidence.
The screenshot hash identifies the produced artifact, not a fixed pixel-golden
assertion across browser builds.

## Gates and rollout order

1. Before build or test activity, run `./bin/eh status` as required by
   `CLAUDE.md`. Run focused tests, `pnpm build`, `pnpm test`, and affected
   `./bin/eh test integration` coverage. Build and launch the browser image
   separately; native-image and live-job tests are affected integration or
   release evidence, not part of a fast unit gate.
2. Run the local k3d live script and agent scenarios using the documented
   cluster owner and CLI setup. Inspect `eve job diagnose`, `eve job logs`,
   artifacts, image identities, and isolation. For each modifying unit, use the
   single-controller protocol to freeze exact base/head/tree, generate its
   reviewer packet, reproduce `candidateDiffCommand` and
   `sce candidate-digest`, record the verdict against that exact pair, and
   integrate under the repository's protected/CAS contract. Repair P0/P1
   findings and re-review changed bytes. Record the exact landed object and
   Git/Beads remote readbacks before selecting the next unit.
3. After U3 integrates and release gates pass, complete U4: publish the
   independently versioned browser toolchain image and platform service
   images. The AWS registry owner first provisions the browser repository in
   its authoritative deployment instance Terraform. The target deployment
   instance owner updates and rolls out that instance using its own repository
   and operational procedures. Repeat BR-03, BR-04, BR-06, BR-07, BR-08, and
   BR-09 where runner mode is enabled on the deployed versions.
4. Add the fix/release refs, deployed image digests, job IDs, versions, probe
   output, and screenshot hashes to issue #6. Close it only after the hosted
   script and agent checks have passed and a missing capability still fails as
   setup. Do not infer hosted success from local Docker or source-level tests.

## Controller preflight note

At plan time the canonical Git `main` and `origin/main` both resolve to
`cf2ad69`, and the working tree is clean. Beads is embedded, but it has no
configured Dolt remote; `refs/dolt/data` is absent from the canonical Git
remote. Before creating or claiming the epic and children, select and prove an
authorized Beads synchronization mode and acquire the controller slot. The
`gt:slot` merge-slot issue is a lock, not a work item. This plan does not
assert cross-host controller ownership or remote Beads synchronization.

## Adversarial plan review

Two fresh read-only review rounds checked the plan against issue #6 and the
current source. No code candidate or live runtime was reviewed.

| Round | Findings | Plan correction |
| --- | --- | --- |
| 1 | P1: pre-job probe could miss a job-installed incompatible Playwright client; worker script setup errors were generic; ARM64 was promised without released ARM64 service images. P2: final environment could differ from the probe; mutable-tag cache provenance was weak; review was not bound to exact candidate bytes. | Bundle the pinned client behind an absolute wrapper; name the worker script path and structured error; limit beta to AMD64; probe after final environment assembly; resolve/store digests and refresh moved tags; require exact SCE review/integration evidence. |
| 2 | P1: U3 required hosted evidence before the release that enables it; the publisher would create an AWS repository outside Terraform. P2: runner support lacked owned paths and failure tests; a source-image digest was overstated as executed-file integrity. | Separate U4 hosted verification from U3 merge acceptance; provision registry infrastructure through owning Terraform and make the workflow read-only; assign runner paths and add BR-09; describe digest as source provenance and test cache refresh. |

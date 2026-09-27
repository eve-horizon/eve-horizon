# Scenario 57: Declared browser runtime

**Time:** ~25 minutes plus builds. **Parallel safe:** No. **LLM:** real Codex OAuth.

Use a disposable, operator-owned local k3d stack. These checks change service
execution modes and toolchain tags; never run them on a shared cluster.

## Prepare

```sh
./bin/eh status
export EVE_API_URL=http://api.eve.lvh.me
eve system health --json
eve auth status
export ORG_ID=org_manualtestorg
eve project ensure --org "$ORG_ID" --name browser-runtime-manual --slug br57 \
  --repo-url https://github.com/eve-horizon/eve-horizon.git --branch main --force --json
export PROJECT_ID=<id_from_output>
export SOURCE_REPO="$(git rev-parse --show-toplevel)"
export FIXTURE_DIR="$SOURCE_REPO/tests/manual/fixtures/browser-runtime"
export MANUAL_REPO="$(mktemp -d "${TMPDIR:-/tmp}/eve-browser-manual.XXXXXX")"
git clone --shared "$SOURCE_REPO" "$MANUAL_REPO"
python3 "$FIXTURE_DIR/generate_manifest.py" "$MANUAL_REPO"
eve project sync --project "$PROJECT_ID" --dir "$MANUAL_REPO" --local --allow-dirty --json
```

The generator embeds exact checked-in HTML and Python bytes into the synced
workflow. Jobs may check out canonical `main` before U3 integrates. The cluster
needs browser/Python toolchain images, this candidate's worker and agent-runtime,
and a working Codex credential. Configure `EVE_RUNTIME_IMAGE_DIGEST` on both
services from their **actual deployed image digests** and compare pod image IDs;
do not supply a tag or guessed value.

## Script and agent (BR-03, BR-04, BR-07)

```sh
eve workflow run "$PROJECT_ID" browser-script --json
eve workflow run "$PROJECT_ID" browser-agent --json
eve job wait <script_root_id> --timeout 600
eve job wait <agent_root_id> --timeout 900
eve job tree <script_root_id>
eve job tree <agent_root_id>
```

For each `render` child, record diagnosis, logs, attachments, and verified
receipt. Set `RUNTIME_DIGEST` to the exact running worker or agent-runtime
image digest for that child:

```sh
export STEP_ID=<render_child_id>
export RUNTIME_DIGEST=sha256:<observed_digest>
eve job diagnose "$STEP_ID" --json > "$STEP_ID.diagnose.json"
eve job logs "$STEP_ID" --summary
eve job attachment "$STEP_ID" --name browser-runtime-receipt.json > "$STEP_ID.receipt.json"
eve job attachment "$STEP_ID" --name browser-runtime-screenshot.png.b64 > "$STEP_ID.png.b64"
python3 "$FIXTURE_DIR/verify_receipt.py" --receipt "$STEP_ID.receipt.json" \
  --screenshot-b64 "$STEP_ID.png.b64" --diagnose "$STEP_ID.diagnose.json" \
  --runtime-digest "$RUNTIME_DIGEST" --out "$STEP_ID.verified.json"
base64 -d < "$STEP_ID.png.b64" > "$STEP_ID.png"
```

Require worker `execution_type=script` and agent-runtime `execution_type=agent`,
with `hints.toolchains=[python,browser]`. The verifier checks text, 40 × 20 SVG
box, PNG hash and size, UID/GID 1000, pinned versions, job/attempt IDs, cache
source digest, and runtime digest against attempt metadata. The agent fixture
reads `eve job diagnose --json` when its harness environment omits the runtime
digest; absence fails before attaching success. The enriched verified JSON is
machine evidence. Agent prose alone is insufficient.

## Isolation and runner (BR-06, BR-09)

Start two `browser-script` workflows without waiting between them. Verify both
as above, require distinct profile paths and per-job attachments, and record
pod memory/storage peaks against limits. PNG hashes may match deterministic
pixels. Inspect UID/GID, seccomp, and privilege settings.

On this isolated stack, have the owner set `EVE_SCRIPT_K8S_RUNNER=true` on the
worker and `EVE_AGENT_RUNTIME_EXECUTION_MODE=runner` on agent-runtime. Re-run
both workflows. Require pulled `runtime_meta.toolchains.image_ids.browser`.
While each runner pod is live, capture it before cleanup:

```sh
./bin/eh kubectl -n eve get pod <runner_pod_name> -o json > "$STEP_ID.pod.json"
```

Pass `--pod-json "$STEP_ID.pod.json"` to the verifier. It checks the observed
main-container `imageID` against `RUNTIME_DIGEST`; the runner receipt uses the
init container's imageID because no `.installed` cache marker exists. Restore
inline mode after these checks.

## Setup failures (BR-05, BR-09)

```sh
eve workflow run "$PROJECT_ID" browser-path-override --json
eve job wait <override_root_id> --timeout 600 || true
eve job diagnose <override_child_id> --json
eve job attachments <override_child_id> --json
```

Require nonzero result and `toolchain_unavailable` with rejected browser path;
no receipt or screenshot attachment. Then set isolated runtimes'
`EVE_TOOLCHAIN_IMAGE_TAG` to a unique tag with an unchanged Python image and
no browser image. Re-run script and agent; require a browser-specific setup
error, no artifact, and no harness/script QA. In runner mode, require browser
init image-pull failure rather than generic timeout.
Restore `local` after each check.

```sh
docker save -o "$MANUAL_REPO/python.tar" eve-horizon/toolchain-python:local
./bin/eh kubectl -n eve port-forward svc/eve-registry 5050:5000
```

In another shell, upload only the unchanged Python image for this missing
browser tag, then set the isolated runtime configuration:

```sh
crane push --insecure "$MANUAL_REPO/python.tar" localhost:5050/eve-horizon/toolchain-python:missing-browser-57
./bin/eh kubectl -n eve set env deploy/eve-worker EVE_TOOLCHAIN_IMAGE_TAG=missing-browser-57
./bin/eh kubectl -n eve set env statefulset/eve-agent-runtime EVE_TOOLCHAIN_IMAGE_TAG=missing-browser-57
# Run both workflows and save diagnosis/attachment lists, then restore:
./bin/eh kubectl -n eve set env deploy/eve-worker EVE_TOOLCHAIN_IMAGE_TAG=local
./bin/eh kubectl -n eve set env statefulset/eve-agent-runtime EVE_TOOLCHAIN_IMAGE_TAG=local
```

Publish disposable browser image variants, with an unchanged Python image
under each matching tag: one changes bundled `browsers.json` headless-shell
`browserVersion` to `0.0.0.0`; one removes `chrome-headless-shell`. Point only
the isolated runtimes at each tag. Re-run both paths; require
`toolchain_unavailable`, browser image/error diagnostics, and no QA attachments.
Keep build/tag/digest logs; never mutate `local` in place. Restore `local` and
re-run a happy path. These live negatives remain required beyond unit tests.
For local image construction, derive each variant from
`eve-horizon/toolchain-browser:local` using a disposable Dockerfile:

```dockerfile
FROM eve-horizon/toolchain-browser:local
ARG BREAK
RUN if [ "$BREAK" = mismatch ]; then \
      sed -i 's/"browserVersion": "[^"]*"/"browserVersion": "0.0.0.0"/g' \
        /toolchain/python/playwright/driver/package/browsers.json; \
    else find /toolchain/browsers -type f -name chrome-headless-shell -exec rm {} \; ; fi
```

Save that Dockerfile as `$MANUAL_REPO/Dockerfile.browser-bad`, then:

```sh
docker buildx build --platform linux/amd64 -f "$MANUAL_REPO/Dockerfile.browser-bad" \
  --build-arg BREAK=mismatch -t eve-horizon/toolchain-browser:badpair --load "$MANUAL_REPO"
docker buildx build --platform linux/amd64 -f "$MANUAL_REPO/Dockerfile.browser-bad" \
  --build-arg BREAK=launch -t eve-horizon/toolchain-browser:badlaunch --load "$MANUAL_REPO"
```

With the registry port-forward running, use `docker save -o` and
`crane push --insecure` as in `eh k8s-image publish-toolchains` to push each
browser variant and the unchanged Python image under matching `badpair` and
`badlaunch` tags. Set `EVE_TOOLCHAIN_IMAGE_TAG` on both isolated runtimes for
each run, then restore `local`. Save registry `crane digest --insecure`
readbacks.

## Warm cache after moved tag (BR-07)

On inline execution, record the source digest from a successful receipt.
Publish a newly built compatible payload under the **same disposable tag**
without clearing cache. Run again: receipt `.installed` and
`runtime_meta.toolchains.browser_source_image_digest` must equal the new
registry digest, differ from the first, and still launch. Keep both registry
readbacks. This is source provenance, not writable cache attestation.

Start diagnosis with `eve job follow`, `eve job logs`, and `eve job diagnose`.
If CLI omits pod init status, the cluster owner may inspect it with
`./bin/eh kubectl`; record the CLI gap.

# Scenario 57: Declared browser runtime

Use an isolated operator-owned k3d stack and Codex OAuth. Runner modes and
image tags change during this scenario.

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

The generator embeds checked-in fixture bytes for pre-merge jobs. Deploy both
service images and browser/Python images with Codex credentials. Set
`EVE_RUNTIME_IMAGE_DIGEST` from each running pod imageID, never a tag.

## Script and agent (BR-03, BR-04, BR-07)

```sh
eve workflow run "$PROJECT_ID" browser-script --json
eve workflow run "$PROJECT_ID" browser-agent --json
eve job wait <script_root_id> --timeout 600
eve job wait <agent_root_id> --timeout 900
```

For each `render` child, set `RUNTIME_DIGEST` from its running service image:

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
```

Require script/agent routing and `[python,browser]` hints. Verified JSON
checks terminal attempt, geometry, PNG, UID/GID, versions, and provenance.

## Isolation and runner (BR-06, BR-09)

Run two script workflows concurrently. Verify distinct profiles/attachments,
UID/GID, seccomp, no escalation, and memory/storage against limits.

Set `EVE_SCRIPT_K8S_RUNNER=true` and
`EVE_AGENT_RUNTIME_EXECUTION_MODE=runner`; re-run both workflows. Require pulled
`runtime_meta.toolchains.image_ids.browser`. Capture each live pod:

```sh
./bin/eh kubectl -n eve get pod <runner_pod_name> -o json > "$STEP_ID.pod.json"
```

Pass `--pod-json` to the verifier for the main imageID. The runner source is
the init imageID. Restore inline mode.

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

In another shell, upload Python and switch the tag:

```sh
crane push --insecure "$MANUAL_REPO/python.tar" localhost:5050/eve-horizon/toolchain-python:missing-browser-57
./bin/eh kubectl -n eve set env deploy/eve-worker EVE_TOOLCHAIN_IMAGE_TAG=missing-browser-57
./bin/eh kubectl -n eve set env statefulset/eve-agent-runtime EVE_TOOLCHAIN_IMAGE_TAG=missing-browser-57
# Run both workflows and save diagnosis/attachment lists, then restore:
./bin/eh kubectl -n eve set env deploy/eve-worker EVE_TOOLCHAIN_IMAGE_TAG=local
./bin/eh kubectl -n eve set env statefulset/eve-agent-runtime EVE_TOOLCHAIN_IMAGE_TAG=local
```

Build disposable badpair and badlaunch browser variants from `local` as below.
Retain Python for both tags. Each script/agent run must fail setup with
browser diagnostics and no QA attachments. Record digests; restore `local`.

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

Push both variants and unchanged Python under matching tags with `docker save`
and `crane push --insecure` (see `eh k8s-image publish-toolchains`). Set the
tag on both runtimes for each run; record `crane digest` and restore `local`.

## Warm cache after moved tag (BR-07)

On inline execution, move a disposable tag to a compatible payload without
clearing cache. Re-run: `.installed` and metadata source digest must match the
new registry digest, differ from the old digest, and still launch. Keep both
readbacks; this proves source provenance, not cache integrity.

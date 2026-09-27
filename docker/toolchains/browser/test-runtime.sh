#!/bin/sh
# Native release gate. A provided image is an already-built, immutable input.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$repo_root"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'native linux/amd64 host required (Mac, Rosetta and QEMU do not qualify)' >&2; exit 1;
fi
daemon_arch=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
[ "$daemon_arch" = linux/amd64 ] || [ "$daemon_arch" = linux/x86_64 ] || {
  echo "native linux/amd64 Docker daemon required: $daemon_arch" >&2; exit 1;
}
docker info --format '{{json .SecurityOptions}}' | grep -q seccomp || {
  echo 'Docker default seccomp is unavailable' >&2; exit 1;
}

if [ -z "${EVE_BROWSER_PYTHON_IMAGE:-}" ]; then
  docker buildx build --platform linux/amd64 -t eve-horizon/toolchain-python:browser-test --load docker/toolchains/python
  EVE_BROWSER_PYTHON_IMAGE=eve-horizon/toolchain-python:browser-test
fi
if [ -z "${EVE_BROWSER_BROWSER_IMAGE:-}" ]; then
  docker buildx build --platform linux/amd64 -t eve-horizon/toolchain-browser:browser-test --load docker/toolchains/browser
  EVE_BROWSER_BROWSER_IMAGE=eve-horizon/toolchain-browser:browser-test
fi
if [ -z "${EVE_BROWSER_WORKER_IMAGE:-}" ]; then
  docker buildx build --platform linux/amd64 -f apps/worker/Dockerfile --target base \
    -t eve-horizon/worker:browser-test --load .
  EVE_BROWSER_WORKER_IMAGE=eve-horizon/worker:browser-test
fi
if [ -z "${EVE_BROWSER_AGENT_RUNTIME_IMAGE:-}" ]; then
  docker buildx build --platform linux/amd64 -f apps/agent-runtime/Dockerfile --target production \
    -t eve-horizon/agent-runtime:browser-test --load .
  EVE_BROWSER_AGENT_RUNTIME_IMAGE=eve-horizon/agent-runtime:browser-test
fi

image_id() {
  docker image inspect --format '{{.Id}}' "$1"
}
assert_platform() {
  platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$1")
  [ "$platform" = linux/amd64 ] || { echo "$1 has unsupported platform $platform" >&2; exit 1; }
}
python_id=$(image_id "$EVE_BROWSER_PYTHON_IMAGE")
browser_id=$(image_id "$EVE_BROWSER_BROWSER_IMAGE")
worker_id=$(image_id "$EVE_BROWSER_WORKER_IMAGE")
agent_id=$(image_id "$EVE_BROWSER_AGENT_RUNTIME_IMAGE")
for pair in "EVE_BROWSER_PYTHON_ID:$python_id" "EVE_BROWSER_BROWSER_ID:$browser_id" \
  "EVE_BROWSER_WORKER_ID:$worker_id" "EVE_BROWSER_AGENT_RUNTIME_ID:$agent_id"; do
  key=${pair%%:*}; actual=${pair#*:}
  eval "expected=\${$key:-}"
  [ -z "$expected" ] || [ "$expected" = "$actual" ] || {
    echo "$key identity changed: expected $expected got $actual" >&2; exit 1;
  }
done
for image in "$EVE_BROWSER_PYTHON_IMAGE" "$EVE_BROWSER_BROWSER_IMAGE" \
  "$EVE_BROWSER_WORKER_IMAGE" "$EVE_BROWSER_AGENT_RUNTIME_IMAGE"; do
  assert_platform "$image"
done

probe_dockerfile=$(mktemp)
work_tag="eve-horizon/worker:browser-source-$$"
agent_tag="eve-horizon/agent-runtime:browser-source-$$"
python_tag="eve-horizon/toolchain-python:browser-source-$$"
browser_tag="eve-horizon/toolchain-browser:browser-source-$$"
trap 'rm -f "$probe_dockerfile"; docker image rm "$work_tag" "$agent_tag" "$python_tag" "$browser_tag" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker tag "$worker_id" "$work_tag"
docker tag "$agent_id" "$agent_tag"
docker tag "$python_id" "$python_tag"
docker tag "$browser_id" "$browser_tag"
cat > "$probe_dockerfile" <<'DOCKERFILE'
ARG PYTHON_IMAGE
ARG BROWSER_IMAGE
ARG RUNTIME_IMAGE
FROM ${PYTHON_IMAGE} AS python_payload
FROM ${BROWSER_IMAGE} AS browser_payload
FROM ${RUNTIME_IMAGE}
COPY --from=python_payload /toolchain /opt/eve/toolchains/python
COPY --from=browser_payload /toolchain /opt/eve/toolchains/browser
DOCKERFILE

for runtime in worker agent-runtime; do
  case "$runtime" in
    worker) source_image=$work_tag; source_id=$worker_id ;;
    agent-runtime) source_image=$agent_tag; source_id=$agent_id ;;
  esac
  probe_image="eve-horizon/${runtime}:browser-probe-$$"
  # The default Docker driver sees daemon-loaded source tags. A setup-buildx
  # docker-container driver has a separate store and cannot COPY from them.
  docker buildx build --builder default --platform linux/amd64 --provenance=false --sbom=false -f "$probe_dockerfile" \
    --build-arg "RUNTIME_IMAGE=$source_image" \
    --build-arg "PYTHON_IMAGE=$python_tag" \
    --build-arg "BROWSER_IMAGE=$browser_tag" \
    -t "$probe_image" --load .
  case "$runtime" in
    worker) memory_limit=3g ;;
    agent-runtime) memory_limit=2g ;;
  esac
  evidence_dir=${EVE_BROWSER_EVIDENCE_DIR:-/tmp/eve-browser-release-evidence}
  mkdir -p "$evidence_dir"
  echo "runtime=$runtime source_image_id=$source_id python_image_id=$python_id browser_image_id=$browser_id memory_limit=$memory_limit tmpfs_limit=256m" | tee "$evidence_dir/$runtime.log"
  if output=$(docker run --rm --platform linux/amd64 --user 1000:1000 \
    --memory "$memory_limit" --memory-swap "$memory_limit" \
    --security-opt no-new-privileges --cap-drop ALL \
    --tmpfs /tmp:rw,size=256m --entrypoint /bin/sh "$probe_image" -ec '
      [ "$(id -u):$(id -g)" = 1000:1000 ]
      grep -E "^(Uid|Gid|NoNewPrivs|Seccomp|CapEff):" /proc/self/status
      grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status
      grep -q "^Seccomp:[[:space:]]*2$" /proc/self/status
      grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status
      browser=/opt/eve/toolchains/browser
      shell=$(find "$browser/browsers" -name chrome-headless-shell -type f | head -n 1)
      test -n "$shell"
      export LD_LIBRARY_PATH="$browser/lib"
      ! ldd "$shell" | grep "not found"
      export FONTCONFIG_FILE="$browser/fonts/fonts.conf"
      "$browser/bin/fc-match" "Liberation Sans" -f "%{family}\n" | grep "Liberation Sans"
      "$browser/bin/eve-browser-python" "$browser/probe.py"
      if [ -f /sys/fs/cgroup/memory.events ]; then
        cat /sys/fs/cgroup/memory.events
        grep -q "^oom_kill 0$" /sys/fs/cgroup/memory.events
      fi
    ' 2>&1); then
    printf '%s\n' "$output" | tee -a "$evidence_dir/$runtime.log"
  else
    printf '%s\n' "$output" | tee -a "$evidence_dir/$runtime.log" >&2
    echo "$runtime native browser smoke failed" >&2
    exit 1
  fi
  docker image rm "$probe_image" >/dev/null
  [ "$(image_id "$source_image")" = "$source_id" ] || { echo 'source image changed' >&2; exit 1; }
done
[ "$(image_id "$python_tag")" = "$python_id" ]
[ "$(image_id "$browser_tag")" = "$browser_id" ]
echo 'native browser release gate passed for both exact runtime bases'

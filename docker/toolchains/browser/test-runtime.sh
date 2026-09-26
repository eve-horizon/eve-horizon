#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$repo_root"

docker buildx build --platform linux/amd64 -t eve-horizon/toolchain-python:browser-test --load docker/toolchains/python

if [ -z "${EVE_BROWSER_WORKER_IMAGE:-}" ]; then
  docker buildx build --platform linux/amd64 -f apps/worker/Dockerfile --target production \
    -t eve-horizon/worker:browser-test --load .
  EVE_BROWSER_WORKER_IMAGE=eve-horizon/worker:browser-test
fi
if [ -z "${EVE_BROWSER_AGENT_RUNTIME_IMAGE:-}" ]; then
  docker buildx build --platform linux/amd64 -f apps/agent-runtime/Dockerfile --target production \
    -t eve-horizon/agent-runtime:browser-test --load .
  EVE_BROWSER_AGENT_RUNTIME_IMAGE=eve-horizon/agent-runtime:browser-test
fi

test_dockerfile=$(mktemp)
trap 'rm -f "$test_dockerfile"' EXIT HUP INT TERM
cat > "$test_dockerfile" <<'DOCKERFILE'
ARG RUNTIME_IMAGE=node:22-slim
FROM ${RUNTIME_IMAGE}
COPY --from=eve-horizon/toolchain-python:browser-test /toolchain /opt/eve/toolchains/python
COPY --from=eve-horizon/toolchain-browser:local /toolchain /opt/eve/toolchains/browser
DOCKERFILE

result=0
for runtime in worker agent-runtime; do
  case "$runtime" in
    worker) source_image=$EVE_BROWSER_WORKER_IMAGE ;;
    agent-runtime) source_image=$EVE_BROWSER_AGENT_RUNTIME_IMAGE ;;
  esac
  test_image="eve-horizon/${runtime}:browser-probe"
  docker buildx build --platform linux/amd64 -f "$test_dockerfile" \
    --build-arg "RUNTIME_IMAGE=$source_image" -t "$test_image" --load .
  echo "Runtime: $runtime"
  docker image inspect --format 'image={{.Id}} size={{.Size}} bytes' "$source_image"
  if docker run --rm --platform linux/amd64 --user 1000:1000 \
    --security-opt no-new-privileges --cap-drop ALL \
    --tmpfs /tmp:rw,size=256m --entrypoint /bin/sh "$test_image" -ec '
      browser=/opt/eve/toolchains/browser
      shell=$(find "$browser/browsers" -name chrome-headless-shell -type f | head -n 1)
      test -n "$shell"
      export LD_LIBRARY_PATH="$browser/lib"
      ! ldd "$shell" | grep "not found"
      export FONTCONFIG_FILE="$browser/fonts/fonts.conf"
      "$browser/bin/fc-match" "Liberation Sans" -f "%{family}\n" | grep "Liberation Sans"
      /opt/eve/toolchains/browser/bin/eve-browser-python "$browser/probe.py"
    '; then
    echo "$runtime browser smoke: passed"
  else
    echo "$runtime browser smoke: failed" >&2
    result=1
  fi
done
exit "$result"

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
worker_source_tag=
agent_source_tag=
trap 'rm -f "$test_dockerfile"; for tag in "$worker_source_tag" "$agent_source_tag"; do if [ -n "$tag" ]; then docker image rm "$tag" >/dev/null 2>&1 || true; fi; done' EXIT HUP INT TERM
cat > "$test_dockerfile" <<'DOCKERFILE'
ARG RUNTIME_IMAGE=node:22-slim
FROM ${RUNTIME_IMAGE}
COPY --from=eve-horizon/toolchain-python:browser-test /toolchain /opt/eve/toolchains/python
COPY --from=eve-horizon/toolchain-browser:local /toolchain /opt/eve/toolchains/browser
DOCKERFILE

worker_image_id=$(docker image inspect --format '{{.Id}}' "$EVE_BROWSER_WORKER_IMAGE")
agent_image_id=$(docker image inspect --format '{{.Id}}' "$EVE_BROWSER_AGENT_RUNTIME_IMAGE")
worker_source_tag="eve-horizon/worker:browser-source-$(printf '%s' "$worker_image_id" | cut -c8-19)"
agent_source_tag="eve-horizon/agent-runtime:browser-source-$(printf '%s' "$agent_image_id" | cut -c8-19)"
docker tag "$worker_image_id" "$worker_source_tag"
docker tag "$agent_image_id" "$agent_source_tag"
result=0
for runtime in worker agent-runtime; do
  case "$runtime" in
    worker) source_image=$worker_source_tag; source_image_id=$worker_image_id ;;
    agent-runtime) source_image=$agent_source_tag; source_image_id=$agent_image_id ;;
  esac
  test_image="eve-horizon/${runtime}:browser-probe"
  docker buildx build --platform linux/amd64 -f "$test_dockerfile" \
    --build-arg "RUNTIME_IMAGE=$source_image" -t "$test_image" --load .
  echo "Runtime: $runtime"
  docker image inspect --format 'image={{.Id}} size={{.Size}} bytes' "$source_image_id"
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
  docker image inspect --format 'source image after smoke={{.Id}}' "$source_image_id"
done
exit "$result"

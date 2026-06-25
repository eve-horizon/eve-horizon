#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K3D_CLUSTER="eve-local"

# shellcheck source=bin/eh-commands/_kube_guard.sh
source "$SCRIPT_DIR/_kube_guard.sh"

show_help() {
  echo "Eve Horizon K8s image helpers"
  echo ""
  echo "Usage: eh k8s-image <command>"
  echo ""
  echo "Commands:"
  echo "  build              Build local api/orchestrator/worker images"
  echo "  import             Import local images into k3d"
  echo "  push               Build + import"
  echo "  build-postgres     Build local Postgres image with supported extensions"
  echo "  import-postgres    Import local Postgres image into k3d"
  echo "  push-postgres      Build + import local Postgres image"
  echo "  build-toolchains   Build toolchain images (python, media, rust, java, kotlin)"
  echo "  import-toolchains   Import toolchain images into k3d node cache"
  echo "  publish-toolchains  Push toolchain images to the in-cluster registry"
  echo "  push-toolchains     Build + import + publish toolchain images"
  echo ""
  echo "Options:"
  echo "  --base-image-tar <path>  Load a Node base image tarball (offline)"
  echo "  --worker-only        Only build worker image"
  echo "  --variant <name>     Worker variant: base, python, rust, java, kotlin, full, all (default: full)"
  echo "  --toolchains <list>  Comma-separated toolchains to build (default: all)"
}

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required tool: $name"
    exit 1
  fi
}

ensure_cluster() {
  if ! command -v k3d >/dev/null 2>&1; then
    echo "Missing required tool: k3d"
    exit 1
  fi
  if ! k3d cluster list | grep -q "^${K3D_CLUSTER}\b"; then
    echo "Cluster '${K3D_CLUSTER}' not found. Run: eh k8s start"
    exit 1
  fi
}

BASE_IMAGE_TAR="${EVE_NODE_BASE_IMAGE_TAR:-}"
WORKER_ONLY=false
VARIANT="full"
TOOLCHAIN_FILTER=""

# Parse all options before command
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-image-tar)
      BASE_IMAGE_TAR="${2:-}"
      shift 2
      ;;
    --worker-only)
      WORKER_ONLY=true
      shift
      ;;
    --variant)
      VARIANT="${2:-}"
      if [[ -z "$VARIANT" ]]; then
        echo "Error: --variant requires a value"
        exit 1
      fi
      shift 2
      ;;
    --toolchains)
      TOOLCHAIN_FILTER="${2:-}"
      if [[ -z "$TOOLCHAIN_FILTER" ]]; then
        echo "Error: --toolchains requires a comma-separated list"
        exit 1
      fi
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  show_help
  exit 1
fi
shift || true

require_bin docker

# Default worker variant for stack builds (not --worker-only)
# Can be overridden via EVE_WORKER_VARIANT environment variable
STACK_WORKER_VARIANT="${EVE_WORKER_VARIANT:-base}"
POSTGRES_LOCAL_IMAGE="${EVE_POSTGRES_LOCAL_IMAGE:-eve-postgres-local:16}"

load_base_image_from_tar() {
  local tar_path="$1"
  if [[ -z "$tar_path" ]]; then
    return 1
  fi
  if [[ ! -f "$tar_path" ]]; then
    echo "Base image tarball not found: $tar_path" >&2
    return 1
  fi

  local load_output
  if ! load_output=$(docker load -i "$tar_path" 2>&1); then
    echo "$load_output" >&2
    return 1
  fi

  local loaded_image
  loaded_image=$(echo "$load_output" | awk -F': ' '/Loaded image: / {print $2}' | tail -n 1)
  if [[ -z "$loaded_image" ]]; then
    return 1
  fi
  echo "$loaded_image"
  return 0
}

resolve_node_base_image() {
  local default_image="node:22-slim"
  local hub_mirror="hubproxy.docker.internal:5555/library/node:22-slim"
  local mirror_image="public.ecr.aws/docker/library/node:22-slim"
  local tar_path="$1"

  if [[ -n "$tar_path" ]]; then
    local tar_image
    tar_image=$(load_base_image_from_tar "$tar_path" || true)
    if [[ -n "$tar_image" ]]; then
      echo "$tar_image"
      return
    fi
  fi
  if [[ -n "${EVE_NODE_BASE_IMAGE:-}" ]]; then
    echo "$EVE_NODE_BASE_IMAGE"
    return
  fi

  if docker image inspect "$default_image" >/dev/null 2>&1; then
    echo "$default_image"
    return
  fi

  if docker pull "$default_image" >/dev/null 2>&1; then
    echo "$default_image"
    return
  fi

  if docker pull "$hub_mirror" >/dev/null 2>&1; then
    echo "$hub_mirror"
    return
  fi

  echo "$mirror_image"
}

# Map variant to Docker target
get_docker_target() {
  local variant="$1"
  case "$variant" in
    base)
      echo "base"
      ;;
    python)
      echo "python"
      ;;
    rust)
      echo "rust"
      ;;
    java)
      echo "java"
      ;;
    kotlin)
      echo "kotlin"
      ;;
    full)
      echo "full"
      ;;
    *)
      echo "Invalid variant: $variant" >&2
      echo "Valid variants: base, python, rust, java, kotlin, full, all" >&2
      exit 1
      ;;
  esac
}

# Build a single worker variant
build_worker_variant() {
  local variant="$1"
  local base_image="$2"
  local target
  target="$(get_docker_target "$variant")"
  local image_name="eve-horizon/worker-${variant}:local"

  echo "Building worker variant: $variant (target: $target)"
  docker build --build-arg NODE_BASE_IMAGE="$base_image" --target "$target" -t "$image_name" -f "$REPO_ROOT/apps/worker/Dockerfile" "$REPO_ROOT"
}

# Import a single worker variant
import_worker_variant() {
  local variant="$1"
  local image_name="eve-horizon/worker-${variant}:local"

  echo "Importing worker variant: $variant"
  k3d image import "$image_name" -c "$K3D_CLUSTER"
}

build_images() {
  local base_image
  base_image="$(resolve_node_base_image "$BASE_IMAGE_TAR")"
  echo "Using base image: $base_image"

  local pids=()

  if [[ "$WORKER_ONLY" == "true" ]]; then
    # Build only worker images with specified variant(s)
    if [[ "$VARIANT" == "all" ]]; then
      # Build all variants in parallel
      local variants=("base" "python" "rust" "java" "kotlin" "full")
      for v in "${variants[@]}"; do
        build_worker_variant "$v" "$base_image" &
        pids+=($!)
      done
    else
      # Build single variant
      build_worker_variant "$VARIANT" "$base_image"
      return
    fi
  else
    # Build all images in parallel (original behavior)
    docker build --build-arg NODE_BASE_IMAGE="$base_image" --target production -t eve-horizon/api:local -f "$REPO_ROOT/apps/api/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
    docker build -t eve-horizon/gateway:local -f "$REPO_ROOT/apps/gateway/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
    docker build --build-arg NODE_BASE_IMAGE="$base_image" --target production -t eve-horizon/orchestrator:local -f "$REPO_ROOT/apps/orchestrator/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
    docker build --build-arg NODE_BASE_IMAGE="$base_image" --target production -t eve-horizon/agent-runtime:local -f "$REPO_ROOT/apps/agent-runtime/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
    docker build --build-arg NODE_BASE_IMAGE="$base_image" --target "$STACK_WORKER_VARIANT" -t eve-horizon/worker:local -f "$REPO_ROOT/apps/worker/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
    docker build -t eve-horizon/sso:local -f "$REPO_ROOT/apps/sso/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
    docker build -t eve-horizon/dashboard:local -f "$REPO_ROOT/apps/dashboard/Dockerfile" "$REPO_ROOT" &
    pids+=($!)
  fi

  # Wait for all builds and check for failures
  local failed=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done

  if [[ $failed -ne 0 ]]; then
    echo "One or more docker builds failed" >&2
    exit 1
  fi
}

import_images() {
  ensure_cluster
  local images=()

  if [[ "$WORKER_ONLY" == "true" ]]; then
    # Import only worker images with specified variant(s)
    if [[ "$VARIANT" == "all" ]]; then
      local variants=("base" "python" "rust" "java" "kotlin" "full")
      for v in "${variants[@]}"; do
        images+=("eve-horizon/worker-${v}:local")
      done
    else
      images+=("eve-horizon/worker-${VARIANT}:local")
    fi
  else
    images+=(
      eve-horizon/api:local
      eve-horizon/gateway:local
      eve-horizon/orchestrator:local
      eve-horizon/agent-runtime:local
      eve-horizon/worker:local
      eve-horizon/sso:local
      eve-horizon/dashboard:local
    )
  fi

  if [[ ${#images[@]} -eq 0 ]]; then
    echo "No images selected for import" >&2
    exit 1
  fi

  echo "Importing ${#images[@]} image(s) into $K3D_CLUSTER in one batch..."
  k3d image import "${images[@]}" -c "$K3D_CLUSTER"
}

build_postgres_image() {
  echo "Building local Postgres image: $POSTGRES_LOCAL_IMAGE"
  docker build -t "$POSTGRES_LOCAL_IMAGE" -f "$REPO_ROOT/tools/postgres-local/Dockerfile" "$REPO_ROOT/tools/postgres-local"
}

import_postgres_image() {
  ensure_cluster
  echo "Importing local Postgres image into $K3D_CLUSTER: $POSTGRES_LOCAL_IMAGE"
  k3d image import "$POSTGRES_LOCAL_IMAGE" -c "$K3D_CLUSTER"
}

ALL_TOOLCHAINS=("python" "media" "rust" "java" "kotlin")

get_toolchains() {
  if [[ -n "$TOOLCHAIN_FILTER" ]]; then
    IFS=',' read -ra tcs <<< "$TOOLCHAIN_FILTER"
    echo "${tcs[@]}"
  else
    echo "${ALL_TOOLCHAINS[@]}"
  fi
}

build_toolchains() {
  local pids=()
  local tcs
  read -ra tcs <<< "$(get_toolchains)"

  for tc in "${tcs[@]}"; do
    local tc_dir="$REPO_ROOT/docker/toolchains/${tc}"
    if [[ ! -f "$tc_dir/Dockerfile" ]]; then
      echo "Skipping toolchain $tc (no Dockerfile found)" >&2
      continue
    fi
    echo "Building toolchain: $tc"
    docker build -t "eve-horizon/toolchain-${tc}:local" -f "$tc_dir/Dockerfile" "$tc_dir" &
    pids+=($!)
  done

  local failed=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done

  if [[ $failed -ne 0 ]]; then
    echo "One or more toolchain builds failed" >&2
    exit 1
  fi
}

import_toolchains() {
  ensure_cluster
  local images=()
  local tcs
  read -ra tcs <<< "$(get_toolchains)"

  for tc in "${tcs[@]}"; do
    images+=("eve-horizon/toolchain-${tc}:local")
  done

  echo "Importing ${#images[@]} toolchain image(s) into $K3D_CLUSTER..."
  k3d image import "${images[@]}" -c "$K3D_CLUSTER"
}

publish_toolchains() {
  ensure_cluster
  require_bin kubectl
  require_bin curl

  local registry_host="${EVE_TOOLCHAIN_REGISTRY_HOST:-eve-registry.eve.svc.cluster.local:5000}"
  local local_port="${EVE_LOCAL_REGISTRY_PORT:-5050}"
  local crane_image="${EVE_CRANE_IMAGE:-gcr.io/go-containerregistry/crane:v0.20.3}"
  local use_crane_container=false
  if ! command -v crane >/dev/null 2>&1; then
    use_crane_container=true
  fi
  local pf_address="${EVE_LOCAL_REGISTRY_ADDRESS:-127.0.0.1}"
  local push_host="localhost"
  if [[ "$use_crane_container" == "true" ]]; then
    # The crane container cannot reach a port-forward bound only to host
    # loopback on Linux Docker. Keep this local-only and short-lived.
    pf_address="${EVE_LOCAL_REGISTRY_ADDRESS:-0.0.0.0}"
    push_host="${EVE_LOCAL_REGISTRY_PUSH_HOST:-host.docker.internal}"
  fi
  local pf_log="${TMPDIR:-/tmp}/eve-registry-port-forward-${local_port}.log"
  local tmp_root="${EVE_TOOLCHAIN_PUBLISH_TMP_ROOT:-$REPO_ROOT/tmp}"
  local tmp_dir
  mkdir -p "$tmp_root"
  tmp_dir="$(mktemp -d "${tmp_root}/eve-toolchain-publish.XXXXXX")"
  local tcs
  read -ra tcs <<< "$(get_toolchains)"
  _EVE_REGISTRY_PF_PID=""
  _EVE_TOOLCHAIN_PUBLISH_TMP_DIR="$tmp_dir"
  cleanup_port_forward() {
    if [[ -n "${_EVE_REGISTRY_PF_PID:-}" ]]; then
      kill "$_EVE_REGISTRY_PF_PID" >/dev/null 2>&1 || true
      wait "$_EVE_REGISTRY_PF_PID" >/dev/null 2>&1 || true
      _EVE_REGISTRY_PF_PID=""
    fi
    if [[ -n "${_EVE_TOOLCHAIN_PUBLISH_TMP_DIR:-}" ]]; then
      rm -rf "$_EVE_TOOLCHAIN_PUBLISH_TMP_DIR"
      _EVE_TOOLCHAIN_PUBLISH_TMP_DIR=""
    fi
  }
  trap cleanup_port_forward EXIT

  eh_kubectl_local -n eve get svc eve-registry >/dev/null

  echo "Port-forwarding eve-registry to ${pf_address}:${local_port}..."
  rm -f "$pf_log"
  eh_kubectl_local -n eve port-forward --address "$pf_address" svc/eve-registry "${local_port}:5000" >"$pf_log" 2>&1 &
  _EVE_REGISTRY_PF_PID=$!

  local ready=false
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${local_port}/v2/" >/dev/null 2>&1; then
      ready=true
      break
    fi
    if ! kill -0 "$_EVE_REGISTRY_PF_PID" >/dev/null 2>&1; then
      echo "Registry port-forward exited early:" >&2
      cat "$pf_log" >&2 || true
      exit 1
    fi
    sleep 1
  done

  if [[ "$ready" != "true" ]]; then
    echo "Timed out waiting for registry port-forward on localhost:${local_port}" >&2
    cat "$pf_log" >&2 || true
    exit 1
  fi

  for tc in "${tcs[@]}"; do
    local local_image="eve-horizon/toolchain-${tc}:local"
    local registry_image="localhost:${local_port}/eve-horizon/toolchain-${tc}:local"
    if ! docker image inspect "$local_image" >/dev/null 2>&1; then
      echo "Missing local image ${local_image}; run: eh k8s-image --toolchains ${tc} build-toolchains" >&2
      exit 1
    fi
    echo "Publishing ${local_image} -> ${registry_host}/eve-horizon/toolchain-${tc}:local"
    local image_tar="${tmp_dir}/toolchain-${tc}.tar"
    docker save -o "$image_tar" "$local_image"
    if [[ "$use_crane_container" == "true" ]]; then
      docker run --rm \
        --add-host=host.docker.internal:host-gateway \
        -v "$tmp_dir:/work:ro" \
        "$crane_image" \
        push --insecure "/work/toolchain-${tc}.tar" "${push_host}:${local_port}/eve-horizon/toolchain-${tc}:local"
    else
      crane push --insecure "$image_tar" "$registry_image"
    fi
  done

  cleanup_port_forward
  trap - EXIT
}

case "$COMMAND" in
  build)
    build_images
    ;;
  import)
    import_images
    ;;
  push)
    build_images
    import_images
    ;;
  build-postgres)
    build_postgres_image
    ;;
  import-postgres)
    import_postgres_image
    ;;
  push-postgres)
    build_postgres_image
    import_postgres_image
    ;;
  build-toolchains)
    build_toolchains
    ;;
  import-toolchains)
    import_toolchains
    ;;
  publish-toolchains)
    publish_toolchains
    ;;
  push-toolchains)
    build_toolchains
    import_toolchains
    publish_toolchains
    ;;
  *)
    show_help
    exit 1
    ;;
esac

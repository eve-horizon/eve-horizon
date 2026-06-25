#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K3D_CLUSTER="eve-local"

show_help() {
  echo "Usage: eh worker-image <command> [options]"
  echo ""
  echo "Commands:"
  echo "  build   Build worker image variant"
  echo "  import  Import worker image into k3d"
  echo "  push    Build + import"
  echo ""
  echo "Options:"
  echo "  --variant <name>  Variant to build: base, python, rust, java, kotlin, full, all (default: full)"
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

# Parse variant option
VARIANT="full"
COMMAND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)
      VARIANT="${2:-}"
      if [[ -z "$VARIANT" ]]; then
        echo "Error: --variant requires a value"
        exit 1
      fi
      shift 2
      ;;
    *)
      if [[ -z "$COMMAND" ]]; then
        COMMAND="$1"
        shift
      else
        echo "Unknown argument: $1"
        show_help
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  show_help
  exit 1
fi

require_bin docker

# Map variant to Docker target
get_docker_target() {
  local variant="$1"
  case "$variant" in
    base)
      echo "runtime-base"
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

# Build a single variant
build_variant() {
  local variant="$1"
  local target
  target="$(get_docker_target "$variant")"
  local image_name="eve-horizon/worker-${variant}:local"

  echo "Building worker variant: $variant (target: $target)"
  docker build --target "$target" -t "$image_name" -f "$REPO_ROOT/apps/worker/Dockerfile" "$REPO_ROOT"
}

# Import a single variant
import_variant() {
  local variant="$1"
  local image_name="eve-horizon/worker-${variant}:local"

  ensure_cluster
  echo "Importing worker variant: $variant"
  k3d image import "$image_name" -c "$K3D_CLUSTER"
}

# Build all variants
build_images() {
  if [[ "$VARIANT" == "all" ]]; then
    # Build all variants in parallel
    local variants=("base" "python" "rust" "java" "kotlin" "full")
    local pids=()

    for v in "${variants[@]}"; do
      build_variant "$v" &
      pids+=($!)
    done

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
  else
    build_variant "$VARIANT"
  fi
}

# Import all variants
import_images() {
  if [[ "$VARIANT" == "all" ]]; then
    local variants=("base" "python" "rust" "java" "kotlin" "full")
    for v in "${variants[@]}"; do
      import_variant "$v"
    done
  else
    import_variant "$VARIANT"
  fi
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
  *)
    show_help
    exit 1
    ;;
esac

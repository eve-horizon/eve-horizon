#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
source "$SCRIPT_DIR/_config.sh"

K3D_CLUSTER="eve-local"

show_help() {
  echo "Eve Horizon App Fast-Path Helpers (local k3d)"
  echo ""
  echo "Usage: eh app <command> [options]"
  echo ""
  echo "Commands:"
  echo "  build <dir>            Build app Docker image from a project directory"
  echo "  import                 Import last-built app image into k3d"
  echo "  deploy <project> <env> Build, import, and deploy an app to k3d"
  echo ""
  echo "Options:"
  echo "  --tag <tag>            Image tag (default: local)"
  echo "  --dockerfile <path>    Dockerfile path relative to project dir (default: Dockerfile)"
  echo "  --image-name <name>    Override the image name (default: derived from project dir)"
  echo ""
  echo "Examples:"
  echo "  # Build and deploy a local app to k3d in one command"
  echo "  eh app deploy my-project test --tag local"
  echo ""
  echo "  # Build app image from a project directory"
  echo "  eh app build ../my-app"
  echo ""
  echo "  # Build and import, then deploy manually with eve CLI"
  echo "  eh app build ../my-app && eh app import"
  echo "  eve env deploy my-project test --direct --skip-preflight --image-tag local"
}

ensure_cluster() {
  require_bin k3d
  if ! k3d cluster list 2>/dev/null | grep -q "^${K3D_CLUSTER}\b"; then
    die "Cluster '${K3D_CLUSTER}' not found. Run: eh k8s start"
  fi
}

# Globals set by parse_options
IMAGE_TAG="local"
DOCKERFILE="Dockerfile"
IMAGE_NAME=""
APP_DIR=""

parse_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag)
        IMAGE_TAG="${2:-}"
        [[ -z "$IMAGE_TAG" ]] && die "--tag requires a value"
        shift 2
        ;;
      --dockerfile)
        DOCKERFILE="${2:-}"
        [[ -z "$DOCKERFILE" ]] && die "--dockerfile requires a value"
        shift 2
        ;;
      --image-name)
        IMAGE_NAME="${2:-}"
        [[ -z "$IMAGE_NAME" ]] && die "--image-name requires a value"
        shift 2
        ;;
      -*)
        die "Unknown option: $1"
        ;;
      *)
        POSITIONAL+=("$1")
        shift
        ;;
    esac
  done
}

derive_image_name() {
  local dir="$1"
  if [[ -n "$IMAGE_NAME" ]]; then
    echo "$IMAGE_NAME"
    return
  fi
  # Derive from directory name
  local base
  base="$(basename "$(cd "$dir" && pwd)")"
  echo "eve-app/${base}"
}

cmd_build() {
  APP_DIR="${POSITIONAL[0]:-}"
  if [[ -z "$APP_DIR" ]]; then
    die "Usage: eh app build <project-dir> [--tag <tag>] [--dockerfile <path>]"
  fi

  if [[ ! -d "$APP_DIR" ]]; then
    die "Directory not found: $APP_DIR"
  fi

  local dockerfile_path="$APP_DIR/$DOCKERFILE"
  if [[ ! -f "$dockerfile_path" ]]; then
    die "Dockerfile not found: $dockerfile_path"
  fi

  local name
  name="$(derive_image_name "$APP_DIR")"
  local full_image="${name}:${IMAGE_TAG}"

  echo -e "${CYAN}Building app image: ${full_image}${NC}"
  echo -e "  Directory:  $APP_DIR"
  echo -e "  Dockerfile: $DOCKERFILE"

  require_bin docker
  docker build -t "$full_image" -f "$dockerfile_path" "$APP_DIR"

  echo -e "${GREEN}Built: ${full_image}${NC}"

  # Store last-built image for import command
  echo "$full_image" > /tmp/eve-app-last-image
}

cmd_import() {
  ensure_cluster

  local image=""
  if [[ ${#POSITIONAL[@]} -gt 0 ]]; then
    image="${POSITIONAL[0]}"
  elif [[ -f /tmp/eve-app-last-image ]]; then
    image="$(cat /tmp/eve-app-last-image)"
  else
    die "No image specified. Run 'eh app build' first or provide an image name."
  fi

  echo -e "${CYAN}Importing ${image} into k3d cluster ${K3D_CLUSTER}${NC}"
  k3d image import "$image" -c "$K3D_CLUSTER"
  echo -e "${GREEN}Imported: ${image}${NC}"
}

cmd_deploy() {
  local project="${POSITIONAL[0]:-}"
  local env_name="${POSITIONAL[1]:-}"

  if [[ -z "$project" || -z "$env_name" ]]; then
    die "Usage: eh app deploy <project> <env> [--tag <tag>]"
  fi

  # If APP_DIR is set (via a 3rd positional arg), build first
  local build_dir="${POSITIONAL[2]:-}"
  if [[ -n "$build_dir" ]]; then
    POSITIONAL=("$build_dir")
    cmd_build
    cmd_import
  elif [[ -f /tmp/eve-app-last-image ]]; then
    # Import last-built image if not already done
    cmd_import
  fi

  echo -e "${CYAN}Deploying ${project}/${env_name} with image tag '${IMAGE_TAG}'${NC}"
  echo -e "  Flags: --direct --skip-preflight --image-tag ${IMAGE_TAG}"

  require_bin eve
  eve env deploy "$project" "$env_name" \
    --direct \
    --skip-preflight \
    --image-tag "$IMAGE_TAG"

  echo -e "${GREEN}Deploy triggered for ${project}/${env_name}${NC}"
}

POSITIONAL=()
COMMAND="${1:-}"
[[ -z "$COMMAND" ]] && { show_help; exit 1; }
shift

parse_options "$@"

case "$COMMAND" in
  build)
    cmd_build
    ;;
  import)
    cmd_import
    ;;
  deploy)
    cmd_deploy
    ;;
  help|--help|-h)
    show_help
    ;;
  *)
    die "Unknown command: $COMMAND. Run 'eh app help' for usage."
    ;;
esac

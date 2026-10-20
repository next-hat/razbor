#!/usr/bin/env bash
set -euo pipefail

# Build one service at a time so release work does not saturate the workstation.
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tag=${RAZBOR_IMAGE_TAG:-0.1.0}
explicit_tag=false
if [[ -n ${RAZBOR_IMAGE_TAG:-} ]]; then explicit_tag=true; fi
output=--load
services=()

usage() {
  cat <<'USAGE'
Usage: scripts/publish-images.sh [--tag TAG] [--push] [SERVICE ...]

Build linux/amd64 images for ghcr.io/next-hat/razbor-SERVICE.
Without --push, load them into the local Docker image store.
Publishing requires --tag or a nonempty RAZBOR_IMAGE_TAG.
Services: web indexer runner embeddings postgres migrate (default: all).
Authenticate with docker login ghcr.io before pushing private packages.
USAGE
}

while (($#)); do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || { echo >&2 "--tag requires a value"; exit 2; }
      tag=$2
      explicit_tag=true
      shift 2
      ;;
    --push) output=--push; shift ;;
    --help|-h) usage; exit 0 ;;
    web|indexer|runner|embeddings|postgres|migrate)
      services+=("$1")
      shift
      ;;
    *) echo >&2 "Unknown argument: $1"; usage >&2; exit 2 ;;
  esac
done

[[ $tag =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || {
  echo >&2 "Invalid Docker image tag"
  exit 2
}
if [[ $output == --push && $explicit_tag != true ]]; then
  echo >&2 "Publishing requires an explicit release tag: use --tag TAG or RAZBOR_IMAGE_TAG."
  exit 2
fi
if ((${#services[@]} == 0)); then
  services=(web indexer runner embeddings postgres migrate)
fi
command -v docker >/dev/null || { echo >&2 "Docker is required"; exit 1; }
docker buildx version >/dev/null

revision=$(git -C "$root" rev-parse HEAD)
if [[ -n $(git -C "$root" status --porcelain) ]]; then
  echo >&2 "Building the current worktree; the revision label identifies its base commit."
fi

for service in "${services[@]}"; do
  image="ghcr.io/next-hat/razbor-$service:$tag"
  echo "Building $image ($output)"
  docker buildx build \
    --platform linux/amd64 \
    --file "$root/docker/$service.Dockerfile" \
    --tag "$image" \
    --build-arg "VERSION=$tag" \
    --build-arg "REVISION=$revision" \
    --label org.opencontainers.image.source=https://github.com/next-hat/razbor \
    --label "org.opencontainers.image.version=$tag" \
    --label "org.opencontainers.image.revision=$revision" \
    --cache-from "type=registry,ref=$image" \
    --cache-to type=inline \
    "$output" \
    "$root"
done

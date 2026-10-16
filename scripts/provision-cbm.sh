#!/usr/bin/env bash
set -euo pipefail
# Explicit operator setup; never called by a review or a service startup.
[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] || { echo "Requires Linux x86_64" >&2; exit 1; }
destination="${1:?Usage: scripts/provision-cbm.sh /absolute/bundle-directory}"
[[ "$destination" == /* ]] || { echo "Use an absolute destination" >&2; exit 1; }
archive_sha=1f9e8293eb2bc5c05cfa27a7e8fc033da6d729ffad525ccfcdaa3fd606306683
binary_sha=ce11c141431aeadd788506c3a7e6942db8fd438dec369d0707a39ec9fd8c6510
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" \
  https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/codebase-memory-mcp-linux-amd64-portable.tar.gz
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --status
mkdir -p "$destination"
tar -xzf "$archive" -C "$destination" codebase-memory-mcp LICENSE THIRD_PARTY_NOTICES.md
printf '%s  %s\n' "$binary_sha" "$destination/codebase-memory-mcp" | sha256sum --check --status
printf 'Verified Codebase Memory v0.11.0 portable bundle at %s\n' "$destination"

#!/usr/bin/env bash
set -euo pipefail

# Explicit host setup; never run by Compose or razbor services.
# https://github.com/kata-containers/kata-containers/blob/main/docs/installation.md
# https://docs.docker.com/reference/cli/dockerd/#configure-container-runtimes

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/install-kata.sh

Install Kata Containers 4.2.0 (QEMU, runtime-rs) on Ubuntu 24.04 amd64/arm64.
Requires hardware virtualization and an existing, running, rootful Docker
Engine 26+ managed by docker.service using /etc/docker/daemon.json.

Installs download dependencies with apt, verifies the pinned release SHA-256,
installs into /opt/kata, backs up Docker's configuration, registers runtime
"kata", and reloads Docker. Does not change Docker's default runtime.
Existing Kata installations are left untouched: this is not an upgrade script.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  usage
  exit 0
fi
[[ $# == 0 ]] || { usage >&2; exit 1; }
[[ $EUID == 0 ]] || fail "Run with sudo."
[[ -r /etc/os-release ]] || fail "Cannot identify the operating system."
# shellcheck source=/dev/null
# source /etc/os-release
# [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail "Requires Ubuntu 24.04."

version=4.2.0
case "$(uname -m)" in
  x86_64)
    arch=amd64
    archive_sha=b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8
    ;;
  aarch64)
    arch=arm64
    archive_sha=5dd4e9f2d5ea9e6bdfa2f476b3315335b58252366fcda2775a3094fc8fec376b
    ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac

for command in docker dockerd systemctl modprobe; do
  command -v "$command" >/dev/null || fail "Required command missing: $command. Install Docker Engine first."
done
systemctl is-active --quiet docker.service || fail "docker.service must be running."
docker_local() {
  docker --host unix:///var/run/docker.sock "$@"
}

docker_version="$(docker_local version --format '{{.Server.Version}}')"
[[ "$docker_version" =~ ^([0-9]+)\. ]] || fail "Cannot determine the Docker Engine version."
(( BASH_REMATCH[1] >= 26 )) || fail "Docker Engine 26+ is required (found $docker_version)."
[[ ! -e /opt/kata && ! -L /opt/kata ]] || fail "/opt/kata already exists; refusing to overwrite it."
# [[ -z "$(docker_local info --format '{{if index .Runtimes "kata"}}present{{end}}')" ]] || fail "Docker already has a kata runtime."

if [[ "$arch" == amd64 ]]; then
  if grep -qw vmx /proc/cpuinfo; then
    modprobe kvm_intel
  elif grep -qw svm /proc/cpuinfo; then
    modprobe kvm_amd
  else
    fail "CPU virtualization is unavailable. Enable VT-x/AMD-V (or nested virtualization in the host hypervisor)."
  fi
else
  modprobe kvm
fi
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || fail "/dev/kvm must be available and accessible."

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl jq zstd

daemon_config=/etc/docker/daemon.json
[[ ! -L "$daemon_config" ]] || fail "Refusing to replace a symlink at $daemon_config."
install -d /opt /etc/docker
work_dir="$(mktemp -d /opt/.kata-install.XXXXXX)"
trap 'rm -rf -- "$work_dir"' EXIT
if [[ -e "$daemon_config" ]]; then
  cp -a "$daemon_config" "$work_dir/original-daemon.json"
else
  printf '{}\n' > "$work_dir/original-daemon.json"
fi

shim=/opt/kata/runtime-rs/bin/containerd-shim-kata-v2
kata_config=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml
jq --arg shim "$shim" --arg config "$kata_config" '
  if type != "object" then error("Docker configuration must be an object")
  elif (.runtimes.kata != null) then error("A kata runtime is already configured")
  else .runtimes.kata = {
    runtimeType: $shim,
    options: {ConfigPath: $config}
  } end
' "$work_dir/original-daemon.json" > "$work_dir/daemon.json"
dockerd --validate --config-file "$work_dir/daemon.json"

archive="kata-static-${version}-${arch}.tar.zst"
printf 'Downloading Kata %s for %s (approximately 0.7–1 GB)...\n' "$version" "$arch"
curl --fail --location --show-error --retry 3 --connect-timeout 30 \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$work_dir/$archive" \
  "https://github.com/kata-containers/kata-containers/releases/download/${version}/${archive}"
printf '%s  %s\n' "$archive_sha" "$work_dir/$archive" | sha256sum --check --status
tar --zstd -xf "$work_dir/$archive" -C "$work_dir"
[[ -x "$work_dir$shim" && -f "$work_dir$kata_config" ]] || fail "The release is missing the expected runtime or QEMU configuration."
mv -T "$work_dir/opt/kata" /opt/kata

backup=""
if [[ -e "$daemon_config" ]]; then
  backup="$(mktemp /etc/docker/daemon.json.before-kata.XXXXXX)"
  cp -a "$daemon_config" "$backup"
  printf 'Docker configuration backup: %s\n' "$backup"
fi
install -m 0600 "$work_dir/daemon.json" "$daemon_config"

# Runtime registration is reloadable; existing containers need not be restarted.
if systemctl reload docker.service; then
  for attempt in {1..10}; do
    if [[ "$(docker_local info --format '{{if index .Runtimes "kata"}}present{{end}}')" == present ]]; then
      printf '\nKata %s registered as Docker runtime "kata".\n' "$version"
      printf 'Verify a guest boots: sudo docker --host unix:///var/run/docker.sock run --rm --runtime kata ubuntu:24.04 uname -r\n'
      exit 0
    fi
    sleep 1
  done
fi

if [[ -n "$backup" ]]; then
  cp -a "$backup" "$daemon_config"
else
  rm -f -- "$daemon_config"
fi
systemctl reload docker.service || true
fail "Kata registration failed; restored the previous Docker configuration. Artifacts remain in /opt/kata. Check journalctl -u docker.service."

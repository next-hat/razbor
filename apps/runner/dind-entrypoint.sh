#!/bin/bash
set -euo pipefail

# This image runs inside Kata. Never mount a host Docker socket here.
mount -o remount,rw /proc/sys
export DOCKER_HOST=unix:///var/run/docker.sock
export TINI_SUBREAPER=1
unset DOCKER_TLS_VERIFY DOCKER_CERT_PATH

# The container filesystem survives restarts, but its PID namespace does not.
# Docker's entrypoint removes docker*.pid, which misses its managed containerd.
rm -f /var/run/docker/containerd/containerd.pid

dockerd-entrypoint.sh dockerd \
  --host="$DOCKER_HOST" \
  --storage-driver=overlay2 \
  --log-level=warn &
daemon_pid=$!
runner_pid=

cleanup() {
  trap '' TERM INT
  if [[ -n "$runner_pid" ]]; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  kill -TERM "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
}
trap 'cleanup; exit 0' TERM INT
trap cleanup EXIT

for ((i = 0; i < 120; i++)); do
  docker info >/dev/null 2>&1 && break
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    status=0
    wait "$daemon_pid" || status=$?
    echo >&2 "Docker daemon exited before becoming ready (exit status $status)"
    if ((status == 0)); then status=1; fi
    exit "$status"
  fi
  sleep 0.5
done
docker info >/dev/null

# Image users pass runner flags directly; development Compose may pass Node/dev.ts.
if [[ "$#" == 0 || "$1" == --* ]]; then
  set -- node --import=tsx apps/runner/src/index.ts "$@"
fi
node --import=tsx apps/runner/src/dind.ts "$@" &
runner_pid=$!
set +e
wait -n "$daemon_pid" "$runner_pid"
status=$?
exit "$status"

#!/usr/bin/env bash
# Host-side driver for the OAC v2 E2E container.
# Usage: [sg docker -c] 'bash evals/e2e-v2/run.sh'
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE="oac-e2e:v2"
REPORT_DIR="${OAC_E2E_OUT:-/tmp/opencode/oac-e2e-out}"
mkdir -p "$REPORT_DIR"

# Rebuild only when the Dockerfile changes.
if [ -n "$(find "$HERE/Dockerfile" -newer "$(docker image inspect -f '{{.Created}}' "$IMAGE" 2>/dev/null || echo /nonexistent)")" ]; then
  echo "[run.sh] rebuilding image $IMAGE ..."
  docker build -t "$IMAGE" "$HERE"
fi

KEY="${ZAI_API_KEY:-${Z_AI_API_KEY:-}}"
if [ -z "$KEY" ]; then
  echo "[run.sh] ERROR: ZAI_API_KEY / Z_AI_API_KEY not set on host" >&2
  exit 1
fi

AUTH=()
if [ -f "$HOME/.local/share/opencode/auth.json" ]; then
  AUTH=(-v "$HOME/.local/share/opencode/auth.json:/home/node/.local/share/opencode/auth.json:ro")
fi

# Repo is mounted READ-ONLY: the container can never mutate the host checkout.
# inside.sh copies it to a writable location before npm install / test runs.
exec docker run --rm \
  -e ZAI_API_KEY \
  -e Z_AI_API_KEY \
  -v "$REPO":/opt/oac:ro \
  -v "$REPORT_DIR":/out \
  "${AUTH[@]}" \
  "$IMAGE" bash /opt/oac/evals/e2e-v2/inside.sh

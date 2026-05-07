#!/bin/bash
# Container entrypoint for the dashboard.
#
# /app/artifacts is expected to be a writable volume (named volume backed by
# EBS in production). On first boot that volume is empty, so we seed it from
# the read-only baseline baked into the image at /app/artifacts-seed.
#
# Subsequent boots leave the volume alone — AI-generated artifacts written at
# runtime persist across restarts and image redeploys.
set -e

ARTIFACTS_DIR="${ARTIFACTS_DIR:-/app/artifacts}"
SEED_DIR="${SEED_DIR:-/app/artifacts-seed}"

mkdir -p "$ARTIFACTS_DIR"

# Seed only when the volume is empty so we never clobber runtime-generated
# artifacts on container restart.
if [ -d "$SEED_DIR" ] && [ -z "$(ls -A "$ARTIFACTS_DIR" 2>/dev/null)" ]; then
  echo "[entrypoint] Seeding $ARTIFACTS_DIR from $SEED_DIR"
  cp -R "$SEED_DIR"/. "$ARTIFACTS_DIR"/
else
  echo "[entrypoint] $ARTIFACTS_DIR already populated, skipping seed"
fi

exec "$@"

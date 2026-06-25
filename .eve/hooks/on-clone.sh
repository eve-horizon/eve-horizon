#!/usr/bin/env bash
set -euo pipefail

echo "[on-clone] Skills already materialized by runtime"

echo "[on-clone] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[on-clone] Building packages..."
pnpm --filter @eve/shared build
pnpm --filter @eve/db build
pnpm --filter @eve/cli build

echo "[on-clone] Complete"

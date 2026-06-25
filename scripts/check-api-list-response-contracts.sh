#!/usr/bin/env bash
set -euo pipefail

# Guardrail: collection endpoints in controllers should not expose raw arrays.
matches="$(rg -n "Promise<[^>\\n]*\\[\\]>" apps/api/src --glob "*controller.ts" || true)"
if [[ -n "$matches" ]]; then
  echo "Found controller list responses using raw arrays:"
  echo "$matches"
  echo ""
  echo "Use the canonical list envelope shape: { data: T[], pagination?: ... }"
  exit 1
fi

echo "API list response contract check passed."

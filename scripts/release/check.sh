#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bash tests/release/helpers.sh
ruby tests/release/workflows.rb

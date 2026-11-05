#!/usr/bin/env bash
# Checks that the worker entrypoint never makes startup wait on a cc-mirror
# variant install. Run: bash docker/worker/entrypoint.test.sh
set -euo pipefail

# The entrypoint needs bash >= 4.4 (empty arrays under set -u), as in the image.
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "SKIP: needs bash >= 4.4, found $BASH_VERSION" >&2
  exit 0
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/home/.local/bin"
# Stub cc-mirror: slow, then writes the variant wrapper and records the call.
cat > "$tmp/bin/cc-mirror" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$tmp/calls"
sleep 2
name=""
while [[ \$# -gt 0 ]]; do [[ "\$1" == "--name" ]] && name="\$2"; shift; done
printf '#!/bin/sh\nexit 0\n' > "$tmp/home/.local/bin/\$name"
chmod +x "$tmp/home/.local/bin/\$name"
STUB
chmod +x "$tmp/bin/cc-mirror"

export HOME="$tmp/home"
# Only system tools: a cc-mirror variant installed on the host must not count.
export PATH="$tmp/home/.local/bin:$tmp/bin:/usr/bin:/bin"
unset Z_AI_API_KEY
# shellcheck disable=SC1091
EVE_ENTRYPOINT_FUNCTIONS_ONLY=1 source "$here/entrypoint.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. A missing variant is installed in the background: the call returns at once.
start=$SECONDS
install_missing_variants_in_background 2>/dev/null
(( SECONDS - start <= 1 )) || fail "install blocked startup for $((SECONDS - start))s"
[[ ! -x "$HOME/.local/bin/mclaude" ]] || fail "install finished synchronously"

for _ in $(seq 1 50); do
  [[ -x "$HOME/.local/bin/mclaude" ]] && break
  sleep 0.1
done
[[ -x "$HOME/.local/bin/mclaude" ]] || fail "background install never produced mclaude"
grep -q -- "--name mclaude" "$tmp/calls" || fail "cc-mirror was not asked for mclaude"
grep -q -- "--name zai" "$tmp/calls" && fail "zai installed without Z_AI_API_KEY"

# 2. A variant already in the image is left alone.
: > "$tmp/calls"
install_missing_variants_in_background 2>/dev/null
sleep 0.5
[[ ! -s "$tmp/calls" ]] || fail "cc-mirror ran although mclaude was present: $(cat "$tmp/calls")"

echo "PASS: entrypoint variant install never blocks startup"

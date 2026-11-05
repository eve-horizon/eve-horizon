#!/usr/bin/env bash
# Checks that the worker entrypoint never makes startup wait on a cc-mirror
# variant install, and that the background installer neither holds the
# worker's secrets nor runs programs a job could have planted.
# Run: bash docker/worker/entrypoint.test.sh
set -euo pipefail

# The entrypoint needs bash >= 4.4 (empty arrays under set -u), as in the image.
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "SKIP: needs bash >= 4.4, found $BASH_VERSION" >&2
  exit 0
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# $tmp/trusted stands in for the image's root-owned /usr/local/bin.
mkdir -p "$tmp/trusted" "$tmp/home/.local/bin"
# Stub cc-mirror: slow, then writes the variant wrapper and records the call
# and the environment it was given.
cat > "$tmp/trusted/cc-mirror" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$tmp/calls"
env > "$tmp/installer-env"
sleep 2
name=""
while [[ \$# -gt 0 ]]; do [[ "\$1" == "--name" ]] && name="\$2"; shift; done
printf '#!/bin/sh\nexit 0\n' > "$tmp/home/.local/bin/\$name"
chmod +x "$tmp/home/.local/bin/\$name"
STUB
chmod +x "$tmp/trusted/cc-mirror"
# A cc-mirror a job planted in its writable ~/.local/bin, first on the job PATH.
printf '#!/bin/sh\ntouch "%s/planted-ran"\n' "$tmp" > "$tmp/home/.local/bin/cc-mirror"
chmod +x "$tmp/home/.local/bin/cc-mirror"

export HOME="$tmp/home"
# The job PATH the container starts with. Only system tools besides the test
# dirs: a cc-mirror or npx installed on the host must not count.
export PATH="$tmp/home/.local/bin:/usr/bin:/bin"
unset Z_AI_API_KEY
# Worker secrets the installer must not inherit: it runs alongside jobs as an
# ordinary process with the worker's UID, so its environment is readable.
export DATABASE_URL="postgres://eve:db-secret@db/eve"
export EVE_INTERNAL_API_KEY="internal-key-secret"
export HTTPS_PROXY="http://proxy.internal:3128"
# shellcheck disable=SC1091
EVE_ENTRYPOINT_FUNCTIONS_ONLY=1 source "$here/entrypoint.sh"
# The entrypoint switched its own PATH to root-owned directories; point that
# at the stand-in so no host installer can run.
[[ "$SERVICE_JOB_PATH" == "$tmp/home/.local/bin:/usr/bin:/bin" ]] || { echo "FAIL: job PATH not kept" >&2; exit 1; }
PATH="$tmp/trusted:/usr/bin:/bin"

fail() { echo "FAIL: $*" >&2; exit 1; }
wait_for() { for _ in $(seq 1 50); do [[ -x "$1" ]] && return 0; sleep 0.1; done; return 1; }

# 1. A missing variant is installed in the background: the call returns at once.
start=$SECONDS
install_missing_variants_in_background 2>/dev/null
(( SECONDS - start <= 1 )) || fail "install blocked startup for $((SECONDS - start))s"
[[ ! -x "$HOME/.local/bin/mclaude" ]] || fail "install finished synchronously"
wait_for "$HOME/.local/bin/mclaude" || fail "background install never produced mclaude"
grep -q -- "--name mclaude" "$tmp/calls" || fail "cc-mirror was not asked for mclaude"
grep -q -- "--name zai" "$tmp/calls" && fail "zai installed without Z_AI_API_KEY"
grep -q "secret" "$tmp/installer-env" && fail "installer inherited worker secrets: $(grep secret "$tmp/installer-env")"
grep -qx "HOME=$HOME" "$tmp/installer-env" || fail "installer lost HOME"
grep -qx "HTTPS_PROXY=http://proxy.internal:3128" "$tmp/installer-env" || fail "installer lost the proxy setting"
grep -qx "PATH=$tmp/trusted:/usr/bin:/bin" "$tmp/installer-env" || fail "installer did not run on the trusted PATH: $(grep ^PATH= "$tmp/installer-env")"
[[ ! -e "$tmp/planted-ran" ]] || fail "installer ran a cc-mirror planted in ~/.local/bin"

# 2. A variant already in the image is left alone.
: > "$tmp/calls"
install_missing_variants_in_background 2>/dev/null
sleep 0.5
[[ ! -s "$tmp/calls" ]] || fail "cc-mirror ran although mclaude was present: $(cat "$tmp/calls")"

# 3. zai is installed once a key is provided, and gets that key.
Z_AI_API_KEY="zai-key" install_missing_variants_in_background 2>/dev/null
wait_for "$HOME/.local/bin/zai" || fail "background install never produced zai"
grep -q -- "--name zai --api-key zai-key" "$tmp/calls" || fail "zai was not installed with its key: $(cat "$tmp/calls")"
grep -q "secret" "$tmp/installer-env" && fail "zai installer inherited worker secrets"

echo "PASS: entrypoint variant install never blocks startup, sees worker secrets or runs planted programs"

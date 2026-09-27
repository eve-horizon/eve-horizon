#!/usr/bin/env bash
set -euo pipefail
source scripts/release/common.sh

expect_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected success: $*" >&2
    exit 1
  fi
}
[[ $(release_ref service worker 1.2.3) == ghcr.io/eve-horizon/eve-horizon/worker:1.2.3 ]]
[[ $(release_ref toolchain browser 0.1.0) == ghcr.io/eve-horizon/eve-horizon/toolchain-browser:0.1.0 ]]
expect_fail bash -c 'source scripts/release/common.sh; release_ref service worker latest'
expect_fail bash -c 'source scripts/release/common.sh; release_ref toolchain unknown 0.1.0'
expect_fail bash -c 'source scripts/release/common.sh; release_ref service api 01.2.3'
expect_fail env GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF=refs/tags/release-v1.2.3 bash scripts/release/validate-tag.sh service
expect_fail env GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/toolchain-images/v0.2.0 bash scripts/release/validate-tag.sh toolchain
[[ $(env GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/toolchain-images/v0.1.0 bash scripts/release/validate-tag.sh toolchain) == 0.1.0 ]]

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/docker" <<'MOCK'
#!/usr/bin/env bash
if [[ $* == 'buildx imagetools inspect '* ]]; then
  case "${MOCK_REMOTE:-}" in
    exists) echo 'Name: existing'; exit 0 ;;
    missing) echo "ERROR: $4: not found" >&2; exit 1 ;;
    missing_manifest) echo "ERROR: failed to get manifest for $4: manifest unknown" >&2; exit 1 ;;
    denied) echo 'unauthorized: authentication required' >&2; exit 1 ;;
    token_404) echo "ERROR: failed to get manifest for $4: unexpected status from GET https://ghcr.io/token: 404 Not Found" >&2; exit 1 ;;
    dns) echo "ERROR: $4: failed to do request: lookup ghcr.io: no such host" >&2; exit 1 ;;
    unrelated_404) echo 'ERROR: unexpected status from HEAD https://ghcr.io/v2/other/manifests/1.2.3: 404 Not Found' >&2; exit 1 ;;
    wrong_ref) echo 'ERROR: ghcr.io/eve-horizon/eve-horizon/worker:1.2.3: not found' >&2; exit 1 ;;
    mixed) printf 'ERROR: %s: not found\nERROR: token endpoint: 404 Not Found\n' "$4" >&2; exit 1 ;;
  esac
fi
if [[ $* == 'load -i '* ]]; then exit 0; fi
if [[ $* == 'image inspect --format {{.Id}} '* ]]; then
  printf 'sha256:%064d\n' 1
  exit 0
fi
exit 98
MOCK
chmod +x "$tmp/docker"
expect_fail env PATH="$tmp:$PATH" MOCK_REMOTE=exists bash -c 'source scripts/release/common.sh; release_check_tag_absent ghcr.io/eve-horizon/eve-horizon/api:1.2.3'
expect_fail env PATH="$tmp:$PATH" MOCK_REMOTE=denied bash -c 'source scripts/release/common.sh; release_check_tag_absent ghcr.io/eve-horizon/eve-horizon/api:1.2.3'
for failure in token_404 dns unrelated_404 wrong_ref mixed; do
  expect_fail env PATH="$tmp:$PATH" MOCK_REMOTE="$failure" bash -c 'source scripts/release/common.sh; release_check_tag_absent ghcr.io/eve-horizon/eve-horizon/api:1.2.3'
done
for absence in missing missing_manifest; do
  env PATH="$tmp:$PATH" MOCK_REMOTE="$absence" bash -c 'source scripts/release/common.sh; release_check_tag_absent ghcr.io/eve-horizon/eve-horizon/api:1.2.3'
done
mkdir -p "$tmp/artifact"
printf 'bad archive' > "$tmp/artifact/image.tar.gz"
printf 'ref=ghcr.io/eve-horizon/eve-horizon/api:1.2.3\nid=sha256:%064d\nsha256=%064d\nrevision=%040d\n' 0 0 0 > "$tmp/artifact/receipt.txt"
expect_fail env GITHUB_SHA="$(printf '%040d' 0)" PATH="$tmp:$PATH" bash scripts/release/image.sh load service api 1.2.3 "$tmp/artifact"
actual_hash=$(sha256sum "$tmp/artifact/image.tar.gz" | awk '{print $1}')
sed "s/^sha256=.*/sha256=$actual_hash/" "$tmp/artifact/receipt.txt" > "$tmp/artifact/receipt.new"
mv "$tmp/artifact/receipt.new" "$tmp/artifact/receipt.txt"
expect_fail env GITHUB_SHA="$(printf '%040d' 0)" PATH="$tmp:$PATH" bash scripts/release/image.sh load service api 1.2.3 "$tmp/artifact"
echo 'release helper rejection paths passed'

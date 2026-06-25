# Scenario 26: Object Store + Org Filesystem

**Time:** ~10 minutes (phases run incrementally as implementation lands)
**Parallel Safe:** Yes (Phases 0–2 and Phase 4; Phase 3 requires a deploy)
**LLM Required:** No

End-to-end validation of the platform object store stack:
MinIO health, org filesystem presigned URL transport, text file search
indexing, app bucket credential injection, and share token access.

Run phases in order. Each phase is independently re-runnable — re-run
the failing phase after fixing, not the full scenario from scratch.

## What This Tests

| Phase | Capability | Verified By |
|-------|-----------|-------------|
| 0 | MinIO running and reachable | Step 1 |
| 0 | StorageService healthy on API | Step 2 |
| 1 | Org fs upload-url endpoint | Step 3 |
| 1 | Presigned PUT to MinIO | Step 4 |
| 1 | Event ingest with storage_key | Step 5 |
| 1 | Object queryable via GET /fs/objects | Step 6 |
| 1 | SSE event carries download_url | Step 7 |
| 1 | Presigned GET download and hash verification | Step 8 |
| 2 | Text file auto-indexed in org_documents | Step 9 |
| 3 | App bucket declared in manifest; resolved isolation shown in diagnose | Step 10 |
| 3 | App credentials can read/write declared bucket | Step 11 |
| 4 | Share token issued and resolves without auth | Step 12 |
| 4 | Revoked token returns 403 | Step 13 |
| 4 | Public path serves without token | Step 14 |

## Prerequisites

- Smoke tests pass (scenario 01)
- `EVE_API_URL` set (see main README)
- For Phase 3: deploy flow works (scenario 05)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running}
TOKEN=$(eve auth token --raw)

# Helpers used throughout
api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
```

---

## Phase 0: MinIO Health

### Step 1 — MinIO pod running and S3 API reachable

```bash
# Check pod health
eve system pods | grep minio

# Hit the MinIO health endpoint directly
MINIO_URL=$(api "$EVE_API_URL/system/config" | jq -r '.storage_public_endpoint // empty')
echo "MinIO public endpoint: $MINIO_URL"
curl -sf "$MINIO_URL/minio/health/live" && echo "MinIO: OK"
```

**Expected:**
- `eve system pods` shows `eve-minio-0` in `Running` state
- MinIO health endpoint returns HTTP 200

**Failure mode:** MinIO StatefulSet not deployed. Run Phase 0 of the
implementation plan (k8s manifests, `./bin/eh k8s deploy`).

### Step 2 — API reports storage backend configured

```bash
api "$EVE_API_URL/system/health" | jq '.storage // "missing"'
```

**Expected:**
- `storage.status: "ok"` (or similar — implementation defines exact shape)
- `storage.backend` is `"minio"` for local k3d

---

## Phase 1: Org Filesystem Presigned URL Transport

> **Prerequisite**: Phase 0 passes.

### Step 3 — Create a sync link and get an upload URL

```bash
# Create or reuse a sync link for the test org
LINK_ID=$(api "$EVE_API_URL/orgs/$ORG_ID/fs/links" | jq -r '.[0].id // empty')
if [ -z "$LINK_ID" ]; then
  LINK_ID=$(api -X POST "$EVE_API_URL/orgs/$ORG_ID/fs/links" \
    -H "Content-Type: application/json" \
    -d '{"device_name":"scenario-26","mode":"two-way"}' | jq -r '.id')
fi
echo "Link ID: $LINK_ID"

# Obtain link gateway token
LINK_TOKEN=$(api "$EVE_API_URL/orgs/$ORG_ID/fs/links/$LINK_ID/token" | jq -r '.token')
echo "Link token obtained: ${LINK_TOKEN:0:20}..."

# Get a presigned upload URL
UPLOAD_RESP=$(curl -sf \
  -H "x-eve-internal-token: $LINK_TOKEN" \
  "$EVE_API_URL/orgs/$ORG_ID/fs/upload-url?path=/test/scenario-26.md")
echo "$UPLOAD_RESP" | jq '{upload_url: .upload_url[0:80], storage_key, expires_at, max_bytes}'
```

**Expected:**
- `upload_url` is a presigned MinIO URL with `X-Amz-` query params
- `storage_key` is `fs/test/scenario-26.md` (or similar path mapping)
- `max_bytes` is 524288000 (500MB)

### Step 4 — PUT file directly to MinIO via presigned URL

```bash
# Write a test file with known content
cat > /tmp/scenario-26.md <<'EOF'
# Scenario 26 Test Document

This document was uploaded via presigned URL in scenario 26.
Unique marker: eve-object-store-test-xkq7

## Content

Lorem ipsum content for full-text search validation.
EOF

# Compute SHA-256 hash (client-side, before upload)
FILE_HASH=$(sha256sum /tmp/scenario-26.md | awk '{print "sha256:"$1}')
FILE_SIZE=$(wc -c < /tmp/scenario-26.md | tr -d ' ')
STORAGE_KEY=$(echo "$UPLOAD_RESP" | jq -r '.storage_key')
UPLOAD_URL=$(echo "$UPLOAD_RESP" | jq -r '.upload_url')

echo "Hash: $FILE_HASH"
echo "Size: $FILE_SIZE bytes"

# PUT directly to MinIO (bypasses API)
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Content-Type: text/markdown" \
  --data-binary @/tmp/scenario-26.md \
  "$UPLOAD_URL")
echo "PUT status: $HTTP_STATUS"
```

**Expected:**
- HTTP 200 from MinIO presigned PUT
- No `Authorization` header was sent — this is anonymous PUT via presigned URL

**Failure mode:** `403 Forbidden` — presigned URL has expired (re-run Step 3)
or MinIO is not accepting path-style requests (check `forcePathStyle`).

### Step 5 — Ingest event with storage_key

```bash
# POST the event to the internal ingest endpoint
EVENT_RESP=$(curl -sf -X POST \
  -H "x-eve-internal-token: $LINK_TOKEN" \
  -H "Content-Type: application/json" \
  "$EVE_API_URL/internal/orgs/$ORG_ID/fs/events" \
  -d "{
    \"event_type\": \"file.updated\",
    \"path\": \"/test/scenario-26.md\",
    \"content_hash\": \"$FILE_HASH\",
    \"size_bytes\": $FILE_SIZE,
    \"storage_key\": \"$STORAGE_KEY\"
  }")
echo "$EVENT_RESP" | jq '{id, event_type, path, storage_key, download_url: .download_url[0:80]}'
```

**Expected:**
- Event created with `event_type: "file.updated"`
- `storage_key` is echoed back
- `download_url` is present and non-empty (presigned GET URL)

Save the download URL for Step 8:
```bash
DOWNLOAD_URL=$(echo "$EVENT_RESP" | jq -r '.download_url')
```

### Step 6 — Object queryable via GET /fs/objects

```bash
api "$EVE_API_URL/orgs/$ORG_ID/fs/objects?prefix=/test/" | jq '.data[] | {path, content_hash, size_bytes, updated_at}'
```

**Expected:**
- `/test/scenario-26.md` appears in the list
- `content_hash` matches `$FILE_HASH`
- `size_bytes` matches `$FILE_SIZE`

### Step 7 — SSE event stream carries download_url

```bash
# Listen on SSE stream for 5 seconds and capture events
timeout 5 curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/orgs/$ORG_ID/fs/events/stream" 2>/dev/null \
  | grep "data:" | head -5 | while IFS= read -r line; do
    echo "$line" | sed 's/^data: //' | jq '{event_type, path, download_url: .download_url[0:80]}' 2>/dev/null
  done
```

**Expected:**
- At least one event with `event_type: "file.updated"` and `path: "/test/scenario-26.md"`
- `download_url` is present on the event

> Note: The SSE stream shows recent events. If the upload happened more than a
> few seconds ago, post another upload to generate a fresh event.

### Step 8 — Download via presigned URL, verify hash

```bash
# Download via the presigned URL from Step 5
curl -sf "$DOWNLOAD_URL" -o /tmp/scenario-26-downloaded.md

# Verify hash matches what we uploaded
DOWNLOADED_HASH=$(sha256sum /tmp/scenario-26-downloaded.md | awk '{print "sha256:"$1}')
echo "Original hash:   $FILE_HASH"
echo "Downloaded hash: $DOWNLOADED_HASH"
[ "$FILE_HASH" = "$DOWNLOADED_HASH" ] && echo "HASH MATCH: PASS" || echo "HASH MISMATCH: FAIL"

# Verify content
grep "eve-object-store-test-xkq7" /tmp/scenario-26-downloaded.md && echo "CONTENT: PASS"
```

**Expected:**
- Hashes match exactly
- Content contains the unique marker

---

## Phase 2: Text File Search Indexing

> **Prerequisite**: Phase 1 passes (scenario-26.md uploaded).

### Step 9 — Text file auto-indexed in org_documents

```bash
# Wait for async indexer (up to 10s)
echo "Waiting for indexing..."
for i in $(seq 1 10); do
  RESULT=$(api "$EVE_API_URL/orgs/$ORG_ID/docs/search?q=eve-object-store-test-xkq7" | jq '.data | length')
  [ "$RESULT" -gt 0 ] && echo "Indexed after ${i}s: PASS" && break
  sleep 1
done
[ "$RESULT" -eq 0 ] && echo "Not indexed within 10s: FAIL"

# Show the indexed document
api "$EVE_API_URL/orgs/$ORG_ID/docs/search?q=eve-object-store-test-xkq7" \
  | jq '.data[] | {path, source, mime_type, updated_at}'
```

**Expected:**
- Document appears in search results within 10s
- `source: "orgfs"` (not `"api"`)
- `path: "/test/scenario-26.md"`

**Failure mode:** Document not indexed. Check `org_fs_index_queue` for stuck
rows. Verify the API's `@Interval` processor is running (check API logs for
indexer activity).

---

## Phase 3: App Object Stores

> **Prerequisite**: Phase 0 passes + a project with a manifest exists.
> Uses the `eve-horizon-fullstack-example` or any test project.

### Step 10 — Deploy manifest with object_store bucket

Add to the test project's `.eve/manifest.yaml`:

```yaml
services:
  api:
    x-eve:
      object_store:
        isolation: auto
        buckets:
          - name: uploads
            visibility: private
            cors:
              origins: ["http://localhost:3000"]
              methods: [GET, PUT, HEAD, DELETE]
              max_age_seconds: 3600
            lifecycle:
              abort_incomplete_uploads_days: 7
```

Then deploy:

```bash
# Replace with your test project slug
export PROJ_ID=proj_xxx
export REPO_DIR=/path/to/app
eve env deploy test --project "$PROJ_ID" --ref HEAD --repo-dir "$REPO_DIR" --direct
```

After deploy, inspect environment diagnostics and the service environment:

```bash
eve env diagnose $PROJ_ID test --json \
  | jq '.storage_buckets[] | {service_name, name, physical_name, visibility, isolation_mode, iam_role_arn, service_account, cors_json}'

# Check STORAGE_* vars are present in the deployed service pod.
# Replace namespace/service if your org/project/env/service slugs differ.
export APP_NS=eve-manualtestorg-myapp-test
export APP_SERVICE=api
kubectl -n "$APP_NS" exec deploy/"$APP_SERVICE" -- env \
  | grep -E 'STORAGE_(ENDPOINT|REGION|AUTH_MODE|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET_)|AWS_REGION'

# S3 IRSA deployments omit path-style mode and static app keys.
kubectl -n "$APP_NS" exec deploy/"$APP_SERVICE" -- env \
  | grep -E 'STORAGE_FORCE_PATH_STYLE|STORAGE_ACCESS_KEY_ID|STORAGE_SECRET_ACCESS_KEY' || true
```

**Expected:**
- `eve env diagnose` lists the bucket with `service_name`, `name`,
  `physical_name`, `visibility`, `isolation_mode`, and `cors_json`
- `STORAGE_ENDPOINT` — MinIO/S3 endpoint
- `STORAGE_REGION` — storage region
- `STORAGE_BUCKET_UPLOADS` — physical bucket name (e.g. `eve-org-mto-myapp-test-uploads`)
- Local k3d: `isolation_mode: "minio-static-key"`, static app keys are present,
  and `STORAGE_FORCE_PATH_STYLE=true`
- AWS IRSA: `isolation_mode: "irsa"`, `iam_role_arn` and `service_account` are
  present, `STORAGE_AUTH_MODE=irsa`, `AWS_REGION` is set, and static app keys
  are absent

### Step 11 — App bucket read/write round-trip with injected credentials

Run an S3 client in the deployed app pod, using the injected `STORAGE_*`
values. The exact command depends on the app image; this example uses a Node
image with AWS SDK installed. For images without a client, run an equivalent
debug pod with the same `STORAGE_*` values.

```bash
kubectl -n "$APP_NS" exec deploy/"$APP_SERVICE" -- sh -lc '
node - <<'"'"'NODE'"'"'
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
(async () => {
  const bucket = process.env.STORAGE_BUCKET_UPLOADS;
  const endpoint = process.env.STORAGE_ENDPOINT;
  const region = process.env.STORAGE_REGION || "us-east-1";
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
    credentials: process.env.STORAGE_AUTH_MODE === "irsa"
      ? undefined
      : {
          accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
          secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
        },
  });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: "scenario-26/probe.txt", Body: "scenario-26" }));
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: "scenario-26/probe.txt" }));
  console.log(await res.Body.transformToString());
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
'
```

**Expected:**
- `PutObject` succeeds
- `GetObject` returns `scenario-26`
- On AWS staging, negative checks with the same app credentials fail for
  `demo-eve-internal`, `demo-eve-org-*`, `CreateBucket`, `PutBucketPolicy`, and
  `PutBucketCors`
- Do not assert that another `demo-eve-app-*` bucket is inaccessible; staging
  currently uses one shared app-bucket IAM principal for that prefix

---

## Phase 4: Share Tokens and Public Paths

> **Prerequisite**: Phase 1 passes (scenario-26.md is in org fs).

### Step 12 — Issue share token and access without auth

```bash
# Issue a share token (1 hour TTL)
SHARE_RESP=$(api -X POST \
  -H "Content-Type: application/json" \
  "$EVE_API_URL/orgs/$ORG_ID/fs/share" \
  -d '{"path": "/test/scenario-26.md", "expires_in": "1h", "label": "Scenario 26 test share"}')
echo "$SHARE_RESP" | jq '{id, url, expires_at}'

SHARE_URL=$(echo "$SHARE_RESP" | jq -r '.url')
echo "Share URL: $SHARE_URL"

# Access the share URL WITHOUT auth (no Bearer token)
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -L "$SHARE_URL")
echo "Share URL status (no auth): $HTTP_STATUS"
[ "$HTTP_STATUS" = "200" ] && echo "Share access: PASS" || echo "Share access: FAIL ($HTTP_STATUS)"
```

**Expected:**
- Share token issued with a `url` and `expires_at`
- Accessing the URL without `Authorization` header follows the 302 redirect and returns 200 with file content

### Step 13 — Revoke token and verify 403

```bash
SHARE_TOKEN=$(echo "$SHARE_RESP" | jq -r '.id')

# Revoke
api -X DELETE "$EVE_API_URL/orgs/$ORG_ID/fs/shares/$SHARE_TOKEN"
echo "Revoke: OK"

# Access after revoke — must be 403
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -L "$SHARE_URL")
echo "Post-revoke status: $HTTP_STATUS"
[ "$HTTP_STATUS" = "403" ] && echo "Revoke enforcement: PASS" || echo "Revoke enforcement: FAIL ($HTTP_STATUS)"
```

**Expected:**
- Revoke call succeeds (HTTP 200/204)
- Subsequent access to the URL returns 403 immediately (no redirect)

### Step 14 — Publish a path prefix for token-free access

```bash
# Publish the /test/ prefix
api -X POST \
  -H "Content-Type: application/json" \
  "$EVE_API_URL/orgs/$ORG_ID/fs/public-paths" \
  -d '{"path_prefix": "/test/", "label": "Scenario 26 public test area"}'

# Derive the public URL for the file (no token query param)
PUBLIC_URL="$EVE_API_URL/orgs/$ORG_ID/fs/public/test/scenario-26.md"
echo "Public URL: $PUBLIC_URL"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -L "$PUBLIC_URL")
echo "Public path status (no auth, no token): $HTTP_STATUS"
[ "$HTTP_STATUS" = "200" ] && echo "Public path: PASS" || echo "Public path: FAIL ($HTTP_STATUS)"

# Clean up: unpublish
PATH_ID=$(api "$EVE_API_URL/orgs/$ORG_ID/fs/public-paths" | jq -r '.data[] | select(.path_prefix=="/test/") | .id')
api -X DELETE "$EVE_API_URL/orgs/$ORG_ID/fs/public-paths/$PATH_ID"
echo "Unpublished."
```

**Expected:**
- `POST /fs/public-paths` succeeds
- `GET /fs/public/test/scenario-26.md` returns 200 without any auth or token
- Unpublish succeeds

---

## Success Criteria

**Phase 0:**
- [ ] `eve-minio-0` pod is `Running`
- [ ] `GET ${MINIO_URL}/minio/health/live` returns HTTP 200
- [ ] API system health shows `storage.status: "ok"`

**Phase 1:**
- [ ] `GET /fs/upload-url` returns valid presigned PUT URL
- [ ] Presigned PUT to MinIO returns HTTP 200
- [ ] Event ingest with `storage_key` returns event with `download_url`
- [ ] `GET /fs/objects?prefix=/test/` shows the uploaded file with matching hash
- [ ] SSE stream events carry `download_url` for file events
- [ ] Content downloaded via presigned URL has matching SHA-256 hash

**Phase 2:**
- [ ] Uploaded `.md` file appears in `org_documents` search within 10s
- [ ] Indexed document has `source: "orgfs"`

**Phase 3:**
- [ ] Deploy with `x-eve.object_store.buckets` injects bucket env vars
- [ ] Local k3d resolves to `minio-static-key` with static keys and path-style mode
- [ ] AWS staging resolves to `irsa` with service account metadata and no static keys
- [ ] `eve env diagnose` lists the declared storage bucket entries and isolation metadata
- [ ] `PutObject`/`GetObject` using app bucket credentials succeeds
- [ ] AWS staging app credentials cannot access platform/org buckets or run bucket-admin actions

**Phase 4:**
- [ ] Share token URL accessible without auth (follows 302 → 200)
- [ ] Revoked token returns 403 immediately
- [ ] Published path prefix accessible without token or auth

## Cleanup

```bash
# Remove test file from org fs
api -X DELETE "$EVE_API_URL/orgs/$ORG_ID/fs/objects/test%2Fscenario-26.md" 2>/dev/null || true

# Remove sync link created for this scenario (if test-only)
api -X DELETE "$EVE_API_URL/orgs/$ORG_ID/fs/links/$LINK_ID" 2>/dev/null || true

echo "Cleanup complete."
```

## CLI Gaps Identified

_Update this section during testing when kubectl was needed but shouldn't be._

| Gap | Current Workaround | Suggested CLI Addition |
|-----|-------------------|----------------------|
| Check MinIO pod status | `eve system pods \| grep minio` | `eve system storage status` |
| Inspect org_fs_index_queue stuck rows | Direct DB query | `eve fs index-queue --org <org>` |

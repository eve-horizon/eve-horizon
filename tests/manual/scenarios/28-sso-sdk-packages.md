# Scenario 28: SSO SDK Packages (@eve-horizon/auth + @eve-horizon/auth-react)

**Time:** ~1-2 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Validates the new `@eve-horizon/auth` and `@eve-horizon/auth-react` packages: token claims extraction, user auth middleware, auth config handler, and deployer SSO URL injection.

## Prerequisites

- `EVE_API_URL` set (see main README)
- Local k3d stack deployed (`./bin/eh k8s deploy`)
- Authenticated: `eve auth login`

## Steps

### 1. Package Build Verification

```bash
pnpm --filter @eve-horizon/auth build 2>&1 && echo "PASS: @eve-horizon/auth builds" || echo "FAIL"
pnpm --filter @eve-horizon/auth-react build 2>&1 && echo "PASS: @eve-horizon/auth-react builds" || echo "FAIL"
```

**Expected:**
- Both packages compile without errors

### 2. Auth Config Endpoint Returns SSO URL

```bash
curl -s $EVE_API_URL/auth/config | jq .
```

**Expected:**
- Response includes `sso_url` field with non-null value (e.g., `http://sso.eve.lvh.me`)
- Response includes `supabase_url` and `anon_key`

### 3. User Token Contains orgs Claim

```bash
TOKEN=$(eve auth token)
# Decode JWT payload (middle segment)
echo "$TOKEN" | cut -d. -f2 | python3 -c "
import sys, base64, json
b64 = sys.stdin.read().strip()
b64 += '=' * (4 - len(b64) % 4)
payload = json.loads(base64.urlsafe_b64decode(b64))
print(json.dumps(payload, indent=2))
assert payload.get('type') == 'user', f'Expected type=user, got {payload.get(\"type\")}'
assert isinstance(payload.get('orgs'), list), 'orgs claim missing or not array'
assert len(payload['orgs']) > 0, 'orgs array is empty'
for org in payload['orgs']:
    assert 'id' in org, 'org entry missing id'
    assert 'role' in org, 'org entry missing role'
print('PASS: orgs claim present with correct structure')
"
```

**Expected:**
- Token payload has `type: "user"`
- `orgs` is an array of `{ id, role }` objects
- At least one org entry present

### 4. Token Verification via API

```bash
TOKEN=$(eve auth token)
curl -s $EVE_API_URL/auth/token/verify -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:**
- Returns `valid: true`
- Returns `type: "user"`
- Returns `user_id` and `email`

### 5. EVE_SSO_URL Configured in Worker

```bash
kubectl -n eve get deployment eve-worker -o jsonpath='{.spec.template.spec.containers[0].env}' | \
  python3 -c "
import sys, json
envs = json.loads(sys.stdin.read())
sso = [e for e in envs if e['name'] == 'EVE_SSO_URL']
if sso:
    print(f'EVE_SSO_URL={sso[0][\"value\"]}')
    print('PASS: Worker has EVE_SSO_URL')
else:
    print('FAIL: EVE_SSO_URL not set on worker')
"
```

**Expected:**
- Worker deployment has `EVE_SSO_URL` env var set
- Value matches the SSO ingress URL

### 6. Package Exports Verification

```bash
node -e "
const authPkg = require(process.cwd() + '/packages/auth/dist/index.js');
const exports = Object.keys(authPkg);
console.log('Exports:', exports.join(', '));

// Verify agent auth (existing)
console.assert(typeof authPkg.verifyEveToken === 'function', 'verifyEveToken missing');
console.assert(typeof authPkg.verifyEveTokenRemote === 'function', 'verifyEveTokenRemote missing');
console.assert(typeof authPkg.eveAuthMiddleware === 'function', 'eveAuthMiddleware missing');

// Verify user auth (new)
console.assert(typeof authPkg.eveUserAuth === 'function', 'eveUserAuth missing');
console.assert(typeof authPkg.eveAuthGuard === 'function', 'eveAuthGuard missing');
console.assert(typeof authPkg.eveAuthConfig === 'function', 'eveAuthConfig missing');

console.log('PASS: All expected exports present');
" 2>&1
```

**Expected:**
- All 6 functions exported (3 existing agent auth + 3 new user auth)

### 7. SSO Broker Session Endpoint

```bash
curl -s -o /dev/null -w "%{http_code}" http://sso.eve.lvh.me/session
```

**Expected:**
- Returns `401` (no session cookie) — confirms the endpoint exists and responds

### 8. ${SSO_URL} Manifest Interpolation (Code Verification)

```bash
grep -n 'SSO_URL' apps/worker/src/deployer/deployer.service.ts
```

**Expected:**
- Shows `EVE_SSO_URL` in platform env vars injection
- Shows `${SSO_URL}` in interpolation code

## Success Criteria

- [ ] Both @eve-horizon/auth and @eve-horizon/auth-react packages build successfully
- [ ] Auth config endpoint returns SSO URL
- [ ] User tokens contain orgs claim array
- [ ] Token verification works via API
- [ ] Worker has EVE_SSO_URL environment variable
- [ ] @eve-horizon/auth exports both agent and user auth functions
- [ ] SSO broker session endpoint accessible
- [ ] Manifest interpolation code includes ${SSO_URL}

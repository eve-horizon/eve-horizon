# Scenario 46: Public TCP Ingress

Validate the local k3d public TCP ingress loop using `Service: LoadBalancer`
with klipper-lb and explicit host port mappings.

## Prerequisites

```bash
export EVE_API_URL=http://api.eve.lvh.me
export ORG_ID=org_manualtestorg

./bin/eh status
./bin/eh k8s start --tcp-ports 33033,33334,33400,33500
./bin/eh k8s deploy

eve system health --json
eve org ensure "manual-test-org" --slug mto --json
```

If `eh k8s start --tcp-ports ...` reports that the existing cluster lacks the
requested mappings, recreate the local cluster explicitly:

```bash
./bin/eh k8s start --tcp-ports 33033,33334,33400,33500 --recreate
./bin/eh k8s deploy
```

## 1. Create A Raw TCP Echo App

```bash
PROJECT_DIR="$(mktemp -d)/tcp-edge"
mkdir -p "$PROJECT_DIR/.eve"

cat > "$PROJECT_DIR/server.js" <<'JS'
const net = require('node:net');

const ports = (process.env.PORTS || '33400,33500')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

for (const port of ports) {
  net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  }).listen(port, '0.0.0.0', () => {
    console.log(`listening:${port}`);
  });
}
JS

cat > "$PROJECT_DIR/Dockerfile" <<'DOCKER'
FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORTS=33400,33500
CMD ["node", "server.js"]
DOCKER

cat > "$PROJECT_DIR/.eve/manifest.yaml" <<'YAML'
project: tcp-edge
services:
  device-edge:
    image: device-edge:manual
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "33400"
      - "33500"
    x-eve:
      tcp_ingress:
        listeners:
          - name: a1-gt06
            port: 33400
          - name: mictrack-mt700
            port: 33500
        hostname: trackers
YAML

(
  cd "$PROJECT_DIR"
  git init -b main
  git add .
  git -c user.name='Eve Manual Test' \
    -c user.email='manual-tests@example.invalid' \
    commit -m 'init tcp echo'
)

docker build -t device-edge:manual "$PROJECT_DIR"
k3d image import device-edge:manual -c eve-local
```

## 2. Deploy The App

```bash
PROJECT_ID="$(
  eve project ensure --org "$ORG_ID" \
    --name tcp-edge --slug tcp-edge \
    --repo-url "file://$PROJECT_DIR" --branch main --force --json \
    | jq -r '.id // .project.id'
)"

eve project sync --project "$PROJECT_ID" --dir "$PROJECT_DIR" --json
eve env create test --type persistent --project "$PROJECT_ID" --json
eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json

NAMESPACE="$(eve env show "$PROJECT_ID" test --json | jq -r '.namespace')"
HOST="$(eve env diagnose "$PROJECT_ID" test --json \
  | jq -r '.tcp_ingress[] | select(.service=="device-edge") | .hostname')"
```

Expected: deploy completes and `HOST` is `trackers.lvh.me`.

## 3. Inspect TCP Resources

```bash
./bin/eh kubectl get svc -n "$NAMESPACE"
eve env diagnose "$PROJECT_ID" test --json | jq '.tcp_ingress'
```

Expected:

- A `LoadBalancer` service labelled `eve.tcp_ingress=true`.
- Provider is `klipper`.
- Both listeners report `state=ready`.
- Hostname is `trackers.lvh.me`.

## 4. Probe From The Host

```bash
nc -vz -w 5 "$HOST" 33400
nc -vz -w 5 "$HOST" 33500

eve tcp-ingress test "$PROJECT_ID" test --listener a1-gt06
eve tcp-ingress test "$PROJECT_ID" test --listener mictrack-mt700

printf 'HELLO\n' | nc -w 2 "$HOST" 33400
```

Expected: both connection probes succeed, both CLI probes print `OK`, and the
byte-level probe echoes `HELLO`.

## 5. Remove One Listener

```bash
yq -i '.services.device-edge.x-eve.tcp_ingress.listeners |= map(select(.name != "mictrack-mt700"))' \
  "$PROJECT_DIR/.eve/manifest.yaml"

(
  cd "$PROJECT_DIR"
  git add .eve/manifest.yaml
  git commit -m 'remove mictrack listener'
)

eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
./bin/eh kubectl get svc -n "$NAMESPACE" -l eve.tcp_ingress=true \
  -o jsonpath='{.items[0].spec.ports[*].name}'
nc -vz -w 2 "$HOST" 33500
```

Expected: only `a1-gt06` remains in the Service ports. The removed `33500`
listener refuses or times out.

## 6. Source-IP Allowlist

```bash
yq -i '.services.device-edge.x-eve.tcp_ingress.allow_cidrs = ["10.99.99.0/24"]' \
  "$PROJECT_DIR/.eve/manifest.yaml"

(
  cd "$PROJECT_DIR"
  git add .eve/manifest.yaml
  git commit -m 'restrict tcp ingress allowlist'
)

eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
nc -vz -w 2 "$HOST" 33400
```

Expected on providers that enforce `loadBalancerSourceRanges`: connection is
refused or times out. Older k3s/klipper-lb versions may not enforce this for
`LoadBalancer` services; record that as a local k3d limitation and rely on EKS
verification for the allowlist behavior.

## 7. Opt Out And Recover

```bash
yq -i 'del(.services.device-edge.x-eve.tcp_ingress)' "$PROJECT_DIR/.eve/manifest.yaml"

(
  cd "$PROJECT_DIR"
  git add .eve/manifest.yaml
  git commit -m 'remove tcp ingress'
)

eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
./bin/eh kubectl get svc -n "$NAMESPACE" -l eve.tcp_ingress=true \
  | grep tcp || echo "no tcp svc (expected)"

yq -i '.services.device-edge.x-eve.tcp_ingress = {
  "listeners": [{"name":"a1-gt06","port":33400}],
  "hostname": "trackers"
}' "$PROJECT_DIR/.eve/manifest.yaml"

(
  cd "$PROJECT_DIR"
  git add .eve/manifest.yaml
  git commit -m 'restore tcp ingress'
)

eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
nc -vz -w 5 "$HOST" 33400
```

Expected: opting out removes the TCP LoadBalancer service, restoring the
listener recreates it, and the host probe succeeds again.

## Success Criteria

- `eh k8s start --tcp-ports ...` creates or validates required k3d port mappings.
- Existing clusters without requested mappings fail with a clear `--recreate` hint.
- The local API and worker overlays set TCP ingress provider `klipper` and hosted zone `lvh.me`.
- `eve env diagnose` reports the TCP ingress listeners as ready.
- Host-level `nc` and `eve tcp-ingress test` probes succeed.
- Removing and restoring listeners updates the TCP LoadBalancer service.

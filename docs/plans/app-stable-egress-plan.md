# App Stable Egress Plan

> **⚠️ Superseded** by [`app-stable-egress-v2-plan.md`](./app-stable-egress-v2-plan.md) on 2026-05-06.
>
> The v2 plan replaces the Tailscale exit-node sidecar design described below
> with an EKS public-subnet node group + `hostNetwork: true` deployment.
> Reason for the pivot: HA, throughput, and "no third-party SaaS in a flagship
> customer's production traffic path." See v2 plan §"Why v2" for the full
> argument.
>
> This document is kept as-is for historical record. Don't implement from it.
>
> **Status**: Superseded (Draft)
> **Last Updated**: 2026-05-06
> **Origin**: The camera-poller camera-poller (project `proj_example`, namespace `eve-example-camera-poller-sandbox`, pod `sandbox-api-7cb59db69-kc27t`) reaches its vendor relay over HTTPS but its UDP P2P relay handshake times out. The author concluded "Eve K8s blocks outbound UDP". A live diagnostic against staging on 2026-05-06 falsified that hypothesis and identified the real cause.
> **Verification source (measured 2026-05-06)**:
> - **UDP egress works**: DNS query to `1.1.1.1:53` returned in 4 ms; to `8.8.8.8:53` in 18 ms.
> - **Egress public IP**: `52.215.97.195` (the staging NAT GW EIP).
> - **NAT is symmetric**: three STUN binding requests from the same socket-creation pattern hit three different external ports: `stun.l.google.com:19302 -> 62641`, `stun1.l.google.com:19302 -> 57897`, `stun.cloudflare.com:3478 -> 57584`. Same source IP, different external port per destination = address-and-port-dependent NAT, matching AWS NAT Gateway behavior.
> - **Platform code paths confirming nothing blocks UDP**: `../deployment-instance/terraform/aws/modules/eks/main.tf:126-134` (node SG egress allow-all), `packages/shared/src/k8s/namespace-hardening.ts` (default app namespace policy allows `0.0.0.0/0` egress), `k8s/base/buildkitd-network-policy.yaml` (only checked-in platform NetworkPolicy, buildkit-only).

## Correctness Fixes From Review

The first draft had three material design errors:

1. A Tailscale userspace sidecar is not transparent routing. Tailscale userspace mode exposes SOCKS5/HTTP proxy behavior; the app must be proxy-aware. The camera-poller UDP library is not. Stable egress needs kernel-mode Tailscale in the pod network namespace, with `/dev/net/tun` plus `NET_ADMIN`/`NET_RAW` on the sidecar only.
2. A Tailscale exit node running as a Kubernetes pod behind the same AWS NAT Gateway still exits to the vendor through that NAT Gateway. That does not change the vendor-facing NAT type. The exit node must have its own public EIP path to the Internet, outside the private-subnet NAT Gateway.
3. Staging commands must not use `~/.kube/eve-hosted.yaml`. Use `../deployment-instance/config/kubeconfig.yaml` through `./bin/eve-infra` where possible, or direct `kubectl` with the explicit kubeconfig and EKS context.

Useful upstream references:
- Tailscale userspace mode is proxy-based: <https://tailscale.com/docs/concepts/userspace-networking>
- Tailscale kernel-mode routing preserves IP packet forwarding semantics better than userspace/netstack mode: <https://tailscale.com/docs/reference/kernel-vs-userspace-routers>
- Tailscale container kernel mode requires `/dev/net/tun` and additional capabilities: <https://tailscale.com/docs/features/containers/docker/docker-params>
- AWS NAT Gateway supports UDP but tracks capacity per unique destination tuple: <https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-basics.html>

## Problem Statement

Symmetric NAT breaks P2P UDP protocols that learn an external mapping from one server and expect a different relay server to use that same source-port mapping. The camera relay appears to do this: the app talks to a discovery endpoint, the discovery path records "the client is at public IP:port", and then a relay replies to that learned port. AWS NAT Gateway picks a different external source port when the pod sends to the relay, so the relay's reply targets the wrong mapping. From the pod's view: timeout. From the wire's view: the pod emitted UDP and AWS NAT Gateway used destination-dependent port mappings.

There is no way for an app today to opt out of NAT Gateway egress. There is no manifest field for "give me a stable, hole-punchable egress path". So camera-poller, and any future app that relies on UDP hole punching, STUN-discovered mappings, or a stable source IP for vendor allow-listing, cannot reliably run on EKS-backed Eve environments.

We need one platform feature: a service can declare `egress: stable`, and the platform routes that service's outbound traffic through a shared, platform-managed exit node with a fixed public EIP and empirically verified endpoint-independent UDP source-port mapping.

## Decision

**Manifest contract - one field:**

```yaml
services:
  api:
    x-eve:
      networking:
        egress: stable      # "nat" (default) | "stable"
```

`nat` is the existing path (AWS NAT Gateway on EKS, normal local networking on k3d). It remains the default.

`stable` on EKS triggers two deploy-time behaviors for that service only:

1. The worker injects a platform-managed Tailscale sidecar into the app pod in **kernel mode**, not userspace mode.
2. The sidecar selects a shared platform exit node that runs on a small EC2 instance in a public subnet with an Elastic IP.

`stable` on local k3d is accepted and logged as a no-op. Local development already has direct outbound networking and should not require privileged sidecars.

```
App pod, private EKS subnet
  app container
  eve-stable-egress sidecar (kernel Tailscale, pod network namespace)
        |
        | WireGuard/Tailscale tunnel, ordinary cluster egress
        v
EC2 stable-egress exit node, public subnet, fixed EIP
        |
        | Vendor-facing UDP/TCP leaves through the EC2 EIP, not AWS NAT Gateway
        v
Vendor relay
```

The NAT Gateway remains on the encrypted tunnel leg from the pod to Tailscale/exit-node connectivity. It must not be on the vendor-facing leg.

## Non-Goals

- Do not reuse the Tailscale Kubernetes Operator private-endpoint design for this. That feature exposes tailnet services to cluster workloads; it does not route arbitrary public Internet egress for one app service.
- Do not use Tailscale userspace mode for transparent app traffic. It is proxy-based and unsuitable for non-proxy-aware UDP clients.
- Do not run the exit node as a pod behind the existing NAT Gateway.
- Do not make out-of-band AWS changes. All AWS resources below live in Terraform in `../deployment-instance`.

## Implementation

### Platform repo (`eve-horizon-2`)

`packages/shared/src/schemas/manifest.ts`
- Add:

  ```ts
  export const ServiceNetworkingSchema = z.object({
    egress: z.enum(['nat', 'stable']).default('nat'),
  }).passthrough();
  ```

- Extend `ServiceXeveSchema`:

  ```ts
  networking: ServiceNetworkingSchema.optional(),
  ```

`packages/shared/src/config/schema.ts`
- Add explicit config fields used by the deployer:

  ```ts
  EVE_COMPUTE_MODEL: z.enum(['k3s', 'eks']).optional(),
  EVE_STABLE_EGRESS_EXIT_NODE: z.string().optional(),
  EVE_STABLE_EGRESS_TS_AUTHKEY: z.string().optional(),
  ```

`apps/worker/src/deployer/deployer.service.ts`
- Add `resolveServiceNetworking(service)` and `requiresStableEgress(service)`.
- In `renderManifest`, when `networking.egress === 'stable'`:
  - If `EVE_COMPUTE_MODEL !== 'eks'`: log a no-op warning and render the existing single-container pod.
  - If `EVE_COMPUTE_MODEL === 'eks'` and either stable-egress env var is missing: fail deployment before applying manifests.
  - Create/update a namespace-local Secret named `eve-stable-egress-client` with only `TS_AUTHKEY`.
  - Add a platform sidecar named `eve-stable-egress`:

    ```yaml
    image: tailscale/tailscale:stable
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        add: ["NET_ADMIN", "NET_RAW"]
    env:
      - name: TS_AUTHKEY
        valueFrom:
          secretKeyRef:
            name: eve-stable-egress-client
            key: TS_AUTHKEY
      - { name: TS_USERSPACE, value: "false" }
      - { name: TS_KUBE_SECRET, value: "" }
      - { name: TS_STATE_DIR, value: /var/lib/tailscale }
      - { name: TS_ACCEPT_DNS, value: "false" }
      - { name: TS_ENABLE_HEALTH_CHECK, value: "true" }
      - name: TS_EXTRA_ARGS
        value: "--exit-node=${EVE_STABLE_EGRESS_EXIT_NODE} --exit-node-allow-lan-access=true"
    volumeMounts:
      - { name: tailscale-state, mountPath: /var/lib/tailscale }
      - { name: dev-net-tun, mountPath: /dev/net/tun }
    readinessProbe:
      httpGet: { path: /healthz, port: 9002 }
    ```

  - Add volumes:

    ```yaml
    - name: tailscale-state
      emptyDir: {}
    - name: dev-net-tun
      hostPath:
        path: /dev/net/tun
        type: CharDevice
    ```

  - Add app-container env:

    ```yaml
    - { name: EVE_NETWORK_EGRESS, value: stable }
    - { name: EVE_STABLE_EGRESS_EXIT_NODE, value: "${EVE_STABLE_EGRESS_EXIT_NODE}" }
    ```

- Do **not** add an app `startupProbe` that checks `/var/run/tailscale/tailscaled.sock`. The app container does not need the LocalAPI socket, and a socket check would be brittle. The sidecar readiness probe is enough for Kubernetes readiness; app-level retry still belongs in the app.
- Keep the sidecar scoped to the opted-in service. Other services in the same environment must render byte-for-byte equivalent manifests except for deployment hashes caused by normal release changes.

`apps/worker/src/deployer/__tests__/deployer-stable-egress.spec.ts`
- Assert schema accepts `networking.egress: stable`.
- Assert EKS + configured stable egress injects:
  - sidecar container,
  - `hostPath` `/dev/net/tun`,
  - `tailscale-state` `emptyDir`,
  - `NET_ADMIN` and `NET_RAW`,
  - namespace-local `eve-stable-egress-client` secret reference,
  - app env marker.
- Assert EKS + missing stable-egress config fails before rendering/apply.
- Assert k3d/unset compute model accepts the field but renders no sidecar.
- Assert unset/default `egress` renders no sidecar.

### Infra repo (`deployment-instance-repo`)

All AWS changes go through Terraform.

New module: `terraform/aws/modules/stable-egress/`
- EC2 instance in a public subnet, sized small (`t3.nano`/`t4g.nano` class is enough for camera-poller-scale UDP).
- Elastic IP associated with the instance.
- `source_dest_check = false` because the host forwards traffic as an exit node.
- Security group:
  - outbound all,
  - SSH from `allowed_ssh_cidrs`,
  - UDP `41641` inbound from `0.0.0.0/0` for direct Tailscale/WireGuard connectivity,
  - no vendor-specific inbound rules.
- Cloud-init/user-data:
  - install Tailscale,
  - enable IPv4/IPv6 forwarding,
  - `tailscale up --advertise-exit-node --hostname=${name_prefix}-stable-egress --accept-routes=false --auth-key=<exit-node-key>`,
  - tag the machine as `tag:eve-stable-egress` if tailnet ACLs are configured for auto-approval.

Terraform variables:
- `stable_egress_enabled` (default `false`)
- `tailscale_exit_node_auth_key` (sensitive; from `secrets.auto.tfvars`)
- `tailscale_app_egress_auth_key` (sensitive reusable ephemeral key for app sidecars; from `secrets.auto.tfvars`)

Terraform/Kubernetes integration:
- Add `kubernetes_secret_v1.eve_stable_egress_client` in namespace `eve` with `TS_AUTHKEY = var.tailscale_app_egress_auth_key`.
- Patch the worker Deployment env in the EKS overlay:

  ```yaml
  - name: EVE_STABLE_EGRESS_EXIT_NODE
    value: "example-stable-egress"
  - name: EVE_STABLE_EGRESS_TS_AUTHKEY
    valueFrom:
      secretKeyRef:
        name: eve-stable-egress-client
        key: TS_AUTHKEY
  ```

- Keep `EVE_COMPUTE_MODEL=eks` in the worker EKS overlay.
- Output the exit-node EIP and tailnet hostname.

Operational rollout:

```bash
cd ../deployment-instance/terraform/aws
terraform fmt -recursive
terraform plan
terraform apply
terraform plan   # must show no changes

cd ../..
./bin/eve-infra deploy
./bin/eve-infra health
```

Stop if Terraform shows unrelated infrastructure drift.

### App Secret Bootstrapping

The worker owns app-namespace mirroring. It reads `EVE_STABLE_EGRESS_TS_AUTHKEY` from its own environment and creates `eve-stable-egress-client` only in namespaces that contain at least one `egress: stable` service.

The sidecar sets `TS_KUBE_SECRET=""` and `TS_STATE_DIR=/var/lib/tailscale` to avoid requiring the app pod's service account to create or update Kubernetes Secrets. The app auth key should be reusable and ephemeral/tagged so sidecar restarts do not leave long-lived tailnet machines.

## Verification Loop (against staging)

This loop is the acceptance test. Each step has a stop condition: if the check fails, do not advance.

### Staging Safety Pre-Flight

From `eve-horizon-2`:

```bash
./bin/eh status
```

Required:
- `Staging Owner: true`
- `K8s Owner` can be false; do not rebuild/redeploy local k8s.

From `../deployment-instance`:

```bash
./bin/eve-infra kubeconfig doctor
```

For unavoidable direct `kubectl`, run from `eve-horizon-2` and use only:

```bash
cd ~/dev/eve-horizon/eve-horizon-2
KUBECTL="kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml --context <explicit-eks-context>"
```

Do not use `~/.kube/eve-hosted.yaml` or implicit kube context.

### Step 0 - Re-confirm the Bug Exists

Verifies the underlying problem has not drifted. Run the diagnostic from 2026-05-06:

```bash
$KUBECTL -n eve-example-camera-poller-sandbox cp /tmp/udp-diag.py \
  sandbox-api-7cb59db69-kc27t:/tmp/udp-diag.py -c api
$KUBECTL -n eve-example-camera-poller-sandbox exec sandbox-api-7cb59db69-kc27t -c api \
  -- python3 /tmp/udp-diag.py
```

Expected:
- UDP/53 to `1.1.1.1` -> OK.
- STUN mapped ports differ across servers.
- `vuid.eye4.cn:32100` -> TIMEOUT.

If anything has changed, stop and re-diagnose.

### Step 1 - Provision the Stable Egress Exit Node

Implement and apply the Terraform module from the infra repo:

```bash
cd ../deployment-instance/terraform/aws
terraform fmt -recursive
terraform plan
terraform apply
terraform plan
```

Expected:
- First `plan` shows only the stable-egress EC2/EIP/SG/secret/worker-env changes.
- Final `plan` shows no changes.
- Terraform output includes the exit-node EIP and tailnet hostname.

Then deploy the overlay and verify the platform:

```bash
cd ../..
./bin/eve-infra deploy
./bin/eve-infra health
```

Expected: API health is OK and the worker has `EVE_STABLE_EGRESS_EXIT_NODE` plus `EVE_STABLE_EGRESS_TS_AUTHKEY` configured.

### Step 2 - Validate the Exit Node Itself

Verify the EC2 host is on the tailnet and exits through its own EIP:

```bash
cd terraform/aws
EXIT_IP="$(terraform output -raw stable_egress_public_ip)"
ssh "ubuntu@${EXIT_IP}" 'tailscale status; curl -fsS https://ifconfig.me; ip route'
cd ~/dev/eve-horizon/eve-horizon-2
```

Expected:
- `tailscale status` shows the host online.
- `curl ifconfig.me` returns `EXIT_IP`.
- The host advertises exit-node capability in the Tailscale admin console or via `tailscale status` metadata.

Stop if the exit node is not using its EIP for ordinary Internet egress.

### Step 3 - Validate NAT Semantics Through a One-Off Pod

Before releasing platform code, run a one-off pod with the same kernel-mode sidecar shape. This proves the sidecar and EC2 exit node can route transparent UDP from an EKS pod.

```bash
cd ~/dev/eve-horizon/eve-horizon-2
$KUBECTL create namespace eve-egress-test --dry-run=client -o yaml | $KUBECTL apply -f -
AUTHKEY="$($KUBECTL -n eve get secret eve-stable-egress-client -o jsonpath='{.data.TS_AUTHKEY}' | base64 -d)"
$KUBECTL -n eve-egress-test create secret generic eve-stable-egress-client \
  --from-literal=TS_AUTHKEY="$AUTHKEY" \
  --dry-run=client -o yaml | $KUBECTL apply -f -
```

Apply the test pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: egress-test
  labels:
    app: egress-test
spec:
  containers:
    - name: app
      image: python:3.12-slim
      command: ["sh", "-c", "sleep 3600"]
      env:
        - { name: EVE_NETWORK_EGRESS, value: stable }
    - name: eve-stable-egress
      image: tailscale/tailscale:stable
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          add: ["NET_ADMIN", "NET_RAW"]
      env:
        - name: TS_AUTHKEY
          valueFrom:
            secretKeyRef:
              name: eve-stable-egress-client
              key: TS_AUTHKEY
        - { name: TS_USERSPACE, value: "false" }
        - { name: TS_KUBE_SECRET, value: "" }
        - { name: TS_STATE_DIR, value: /var/lib/tailscale }
        - { name: TS_ACCEPT_DNS, value: "false" }
        - { name: TS_ENABLE_HEALTH_CHECK, value: "true" }
        - name: TS_EXTRA_ARGS
          value: "--exit-node=example-stable-egress --exit-node-allow-lan-access=true"
      volumeMounts:
        - { name: tailscale-state, mountPath: /var/lib/tailscale }
        - { name: dev-net-tun, mountPath: /dev/net/tun }
      readinessProbe:
        httpGet:
          path: /healthz
          port: 9002
  volumes:
    - name: tailscale-state
      emptyDir: {}
    - name: dev-net-tun
      hostPath:
        path: /dev/net/tun
        type: CharDevice
```

Then:

```bash
$KUBECTL -n eve-egress-test wait --for=condition=Ready pod/egress-test --timeout=120s
$KUBECTL -n eve-egress-test cp /tmp/udp-diag.py egress-test:/tmp/udp-diag.py -c app
$KUBECTL -n eve-egress-test exec egress-test -c app -- python3 /tmp/udp-diag.py
```

Expected:
- `egress public IP` equals the stable-egress EIP, not `52.215.97.195`.
- All three STUN servers return the same external mapped port.
- UDP/53 still works.

If the public IP is still `52.215.97.195`, the sidecar is not taking over the pod default route. Check `eve-stable-egress` logs and `ip route` inside the app container.

If STUN ports still differ while the EIP is correct, the exit-node NAT behavior is still not endpoint-independent. Stop and fix the exit-node NAT before touching camera-poller.

### Step 4 - Cut a Platform Release

After the platform code and tests are merged:

```bash
cd ~/dev/eve-horizon/eve-horizon-2
LATEST="$(git tag --list 'release-v*' --sort=-version:refname | head -1)"
NEXT="$(echo "$LATEST" | awk -F. '{print $1"."$2"."$3+1}')"
git tag "$NEXT"
git push origin "$NEXT"
gh run watch --repo example-org/deployment-instance
```

Wait for the infra-repo deploy job to complete. Then:

```bash
eve system health --json | jq .status
```

Expected: `"ok"`.

### Step 5 - Opt camera-poller Into Stable Egress

In the camera-poller app repo, add to its Eve manifest:

```yaml
services:
  api:
    x-eve:
      networking:
        egress: stable
```

Redeploy:

```bash
eve env deploy proj_example sandbox
eve env diagnose proj_example sandbox | tail -30
```

Verify the sidecar is injected:

```bash
$KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api \
  -o jsonpath='{.items[0].spec.containers[*].name}'
```

Expected: `api eve-stable-egress`.

Stop if no `eve-stable-egress` container exists.

### Step 6 - Re-run the Diagnostic From Inside camera-poller

```bash
POD="$($KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api -o name | head -1)"
$KUBECTL -n eve-example-camera-poller-sandbox cp /tmp/udp-diag.py "${POD#pod/}:/tmp/udp-diag.py" -c api
$KUBECTL -n eve-example-camera-poller-sandbox exec "${POD#pod/}" -c api -- python3 /tmp/udp-diag.py
```

Expected:
- Three STUN servers all return the same external mapped port.
- `egress public IP` equals the stable-egress EIP, not `52.215.97.195`.

If symmetric NAT is still observed, check sidecar logs:

```bash
$KUBECTL -n eve-example-camera-poller-sandbox logs "${POD#pod/}" -c eve-stable-egress --tail=200
```

Confirm `TS_EXTRA_ARGS` includes the exit-node flag and the sidecar is not running in userspace mode.

### Step 7 - Real Handshake Check

```bash
eve env logs proj_example sandbox api --tail 100 --follow
```

Trigger the camera poller (it runs every 300 s by default; force one with the app's manual-poll endpoint if available).

Expected:
- Relay attempt succeeds instead of timing out.
- Camera frame count increases in the app database.

If STUN passes but the relay still times out, capture Tailscale sidecar logs and vendor endpoint packet timing, then reopen the protocol diagnosis. At that point the platform egress behavior is probably correct and the remaining issue is app/vendor-specific.

### Step 8 - Rollback Dry Run

Confirm the feature can be disabled per app:

```bash
# Revert the manifest to omit networking.egress
eve env deploy proj_example sandbox
$KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api \
  -o jsonpath='{.items[0].spec.containers[*].name}'
```

Expected: `api` only.

Then re-enable `networking.egress: stable` and redeploy so staging is left in the working state.

## Acceptance

The plan is shipped when:
- [ ] Step 3 proves the one-off pod exits through the stable-egress EIP and has endpoint-independent STUN mappings.
- [ ] Step 6 proves the camera-poller pod exits through the stable-egress EIP and has endpoint-independent STUN mappings.
- [ ] Step 7 shows the relay handshake completing and frames flowing.
- [ ] Step 8 toggles cleanly in both directions.
- [ ] Three unrelated staging apps show no deploy-manifest churn after the platform release.
- [ ] `references/manifest.md` in `eve-skillpacks` documents `x-eve.networking.egress`.
- [ ] `references/deploy-debug.md` in `eve-skillpacks` documents stable egress diagnostics.

## Risks and Follow-Ups

- **Pod privilege**: `egress: stable` requires a sidecar with `NET_ADMIN`, `NET_RAW`, and `/dev/net/tun`. Keep this platform-owned, opt-in, and visible in rendered manifests.
- **NAT semantics are empirical**: If the EC2 exit-node path still produces destination-dependent STUN ports, do not ship. Investigate Linux NAT configuration or a dedicated UDP relay/proxy design.
- **Single exit node**: MVP is one shared exit node. Add HA only after camera-poller is working; likely two EIPs/hosts plus explicit per-env failover, not transparent load balancing, because source-IP stability matters.
- **Tailnet key lifecycle**: Use tagged, ephemeral app-side auth keys and disable key expiry or automate rotation for the exit node. Record the operational rotation process before production.
- **Cost**: This adds one small EC2 instance and EIP. It should be much cheaper than per-app NAT instances and isolated from the existing NAT Gateway data path.

## Out of Scope

- UDP ingress (apps acting as UDP servers: game servers, VPN endpoints). Different problem.
- Stable egress for agent runner pods or one-off service jobs. This plan targets deployed app services first.
- Egress allow-lists / declared destination ports. No app has asked for them; revisit under a default-deny posture.
- Per-app dedicated EIPs / NAT instances. Revisit only if a vendor demands tenant-specific source IP.
- Closed-egress NetworkPolicies in app namespaces. Pre-MVP, the platform is open-by-default; revisit at multi-tenant readiness.

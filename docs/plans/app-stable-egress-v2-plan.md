# App Stable Egress v2 Plan (hostNetwork + public egress node group)

> **Status**: Draft
> **Last Updated**: 2026-05-06
> **Supersedes**: [`app-stable-egress-plan.md`](./app-stable-egress-plan.md) (Tailscale exit-node sidecar design, pivoted 2026-05-06 evening after HA + scale review).
> **Origin**: camera-poller camera-poller (`proj_example`, namespace `eve-example-camera-poller-sandbox`, pod `sandbox-api-7cb59db69-kc27t`) — UDP P2P relay handshake times out behind AWS NAT Gateway; destination-dependent NAT remains the leading theory but must be re-confirmed with the corrected same-socket diagnostic below. Diagnostic: `deployment-instance-repo/scripts/stable-egress/udp-diag.py`.

## Why v2

The v1 plan put a kernel-mode Tailscale sidecar in every opted-in pod and routed traffic through a shared EC2 exit node. That works for "one or two services need stable egress occasionally." It falls over on three constraints camera-poller introduces:

1. **HA.** Tailscale exit nodes don't load-balance. A pod selects one via `--exit-node=<name>`. To go HA you'd build a custom controller that rewrites the arg on health failures. We're not in the "operate Tailscale" business.
2. **High throughput.** Every byte wraps in WireGuard. The shared exit node's NIC and CPU become the bandwidth ceiling for every opted-in app.
3. **External SaaS in the production traffic path.** Tailscale outage = camera-poller outage. Acceptable for an internal experiment, not for a flagship customer's production workload.

For camera-poller specifically (STUN-discovered NAT mappings, not source-IP allow-lists), the right primitive is **host-originated UDP from an EC2 node with its own public IPv4 path**. AWS NAT Gateway breaks because of its NAT semantics; a public-subnet EC2 instance with an associated public IPv4 is translated 1:1 by the Internet Gateway path and should preserve the same UDP source port for the same local socket across destinations. The platform problem reduces to "schedule the opted-in pod onto a node in a public subnet so its egress goes via that node's IGW route." K8s solves that with `hostNetwork: true` + `nodeSelector` + taint/toleration. No tunnel.

## Known facts and diagnostic correction (2026-05-06)

- **UDP egress works** from the cluster: DNS query to `1.1.1.1:53` returned in 4 ms; to `8.8.8.8:53` in 18 ms.
- **Egress public IP**: `52.215.97.195` (the staging NAT GW EIP).
- **Important correction**: the v1 `udp-diag.py` opens a new UDP socket per STUN server. Different external ports from that script are consistent with ordinary per-socket ephemeral port allocation and are **not, by themselves, proof** of address-and-port-dependent NAT.
- **Required before implementation**: update `../deployment-instance/scripts/stable-egress/udp-diag.py` so the STUN section binds one UDP socket once, prints its local port, sends binding requests to all STUN servers from that same socket, and compares mapped `(IP, port)` values across destinations. Only that same-socket result should be used to classify NAT mapping behavior.
- **No platform code blocks UDP**: `../deployment-instance/terraform/aws/modules/eks/main.tf:126-134` (node SG egress allow-all), `packages/shared/src/k8s/namespace-hardening.ts` (default app namespace policy allows `0.0.0.0/0` egress), `k8s/base/buildkitd-network-policy.yaml` (only checked-in NetworkPolicy, buildkit-only).

### AWS VPC CNI MASQUERADE (added during staging verification)

- **Symmetric NAT survives `hostNetwork: true` on EKS by default.** The AWS VPC CNI installs `SNAT --to-source <node_primary_ip> --random-fully` in `AWS-SNAT-CHAIN-0` (POSTROUTING) for every off-VPC packet. `--random-fully` picks a fresh source port per (src, dst) tuple, so the IGW never sees the kernel-chosen port. Even traffic that originates from the node's primary IP (i.e., hostNetwork pods) is re-NAT'd through this rule, which produces address-and-port-dependent mappings exactly like the cluster NAT GW path.
- **Empirical proof on the egress node**: same-socket STUN probe reported port `16458` to Google STUN, port `51006` to Cloudflare STUN. Classification: `address/port-dependent (bad for hole-punching)`.
- **Fix**: insert an early-return rule above the SNAT — `iptables -t nat -I AWS-SNAT-CHAIN-0 1 -s <primary_ip> -j RETURN`. Codified as a privileged DaemonSet (`k8s/overlays/aws-eks/egress-snat-bypass-daemonset.yaml`) that targets only the egress pool (`nodeSelector: eve.io/egress-pool=stable` + matching toleration) so other node groups are unaffected. Verified result: same-socket STUN port `41604` across all three servers, equal to the local socket port. Classification: `endpoint-independent (good)`.
- **Why a DaemonSet not user-data**: AWS VPC CNI rewrites the chain on restart, so the rule has to be re-applied. The DaemonSet's `iptables -C ... || iptables -I ...` loop is idempotent and survives CNI restarts.
- **Plan implication**: Step 3 of the verification loop now requires the `egress-snat-bypass` DaemonSet to be deployed before the same-socket STUN probe will report endpoint-independent mappings.

## Customer context

camera-poller is the only stable-egress app expected in the next year. It is also a **flagship customer** workload that must support **HA** and **high-scale traffic** after POC. That shapes the design two ways:

1. The architecture must be production-credible. POC is not a throwaway prototype — it's phase 1 of the production path.
2. POC scope is allowed to defer everything that doesn't break camera-poller-the-POC. We do not over-build for hypothetical future apps.

The plan therefore defines the production architecture as the destination, then carves out a POC slice that ships in days, not weeks. The transition from POC to production keeps the manifest contract and pod render shape intact; the main changes are node group sizing, subnet list length, EIP pool management, and one broader deployer validation pass.

## Decision

**Manifest contract** (unchanged from v1):

```yaml
services:
  api:
    x-eve:
      networking:
        egress: stable      # 'nat' (default) | 'stable'
```

**Architecture**:

```
App pod (hostNetwork: true)
  scheduled on a node in the egress node group (public subnet, public IPv4 attached)
  app container - no sidecar, no privileged caps
        |
        | binds in the node's network namespace
        v
Node primary ENI private IP
        |
        v
Public-subnet route table -> IGW 1:1 public IPv4 path -> vendor relay
```

`stable` on EKS makes the deployer:
1. Add `nodeSelector: { eve.io/egress-pool: stable }` so the pod only schedules on the egress node group.
2. Add a matching toleration for the `eve.io/egress-pool=stable:NoSchedule` taint.
3. Set `hostNetwork: true` and `dnsPolicy: ClusterFirstWithHostNet` (so the pod can still resolve cluster service DNS).
4. Add `EVE_NETWORK_EGRESS=stable` to the app container env.

`stable` on k3d is accepted and logged as a no-op (k3d has no concept of public-subnet nodes; local dev already has direct egress).

`nat` (default) is unchanged — the rendered Deployment is byte-for-byte identical to today.

## Two-phase rollout

The manifest contract and Phase 1 pod render shape are intended to survive Phase 2. The infra phases differ in node group sizing and EIP strategy; Phase 2 also adds the deployer validation needed for multiple services and replicas.

### Phase 1 — POC (this plan)

**Goal**: camera-poller reaches its vendor relay end-to-end via stable egress. Single client, single environment, no HA target.

| Concern | POC choice |
|---|---|
| Node group size | min=1, max=1, desired=1 |
| Availability zones | Single AZ — `eu-west-1b` (mirrors the eks_agents pin already required for org-fs PV; see CLAUDE.md update log 2026-02-27). |
| Capacity type | `ON_DEMAND` for POC reliability. Do not use Spot for the single-node POC pool. |
| Public IP | Auto-assigned public IPv4 on the node ENI via the launch template / subnet setting. One IP, AWS-allocated, not pre-allocated. |
| Instance type | `t3.medium` (cheap, plenty for camera-poll workload). |
| Vendor source IP | Whatever AWS hands the node. Node replacement, recycle, or upgrade → new IP. camera-poller relies on STUN, not allow-lists, so this is acceptable for POC. |
| Conntrack tuning | Default kernel limits. Sufficient for POC concurrency. |
| Monitoring | None beyond standard EKS node metrics. |

The egress node group module is written so that the Phase 2 capacity and AZ changes are variable bumps. The EIP pool attachment controller and broader deployer validation are explicit Phase 2 additions.

### Phase 2 — Production hardening (deferred, separate plan)

Triggered when camera-poller moves past POC, OR when a second stable-egress app appears, whichever comes first.

| Concern | Production target |
|---|---|
| Node group size | min=2, max=N (sized to peak), desired=2. |
| Availability zones | ≥2 AZs, subnet list passed to the same module. |
| Public IP | Pre-allocated EIP pool of size max_size, attached via launch template + a small lifecycle-hook Lambda (or external-dns-style controller) so each replacement node attaches a deterministic IP from the pool. |
| Instance type | `c6gn.xlarge` or similar, sized to expected aggregate UDP throughput. |
| Vendor source IP | One of N pre-allocated EIPs. Stable across replacements. Vendor allow-listing works against the full set. |
| Conntrack tuning | Raise `net.netfilter.nf_conntrack_max` and `nf_conntrack_buckets` in user-data. |
| Monitoring | NIC throughput, conntrack table utilisation, SG drops, EIP exhaustion alarms. |
| Runbooks | AZ outage, node replacement, EIP exhaustion, conntrack saturation. |
| Deployer | Cluster-wide port-collision validator (the within-render validator from Phase 1 doesn't catch cross-namespace collisions). |
| Failure domain | Tested AZ-failover, including measured camera-poller recovery time. |

None of this changes the manifest contract or the hostNetwork render shape. Phase 2 is delivered by editing Terraform variables, adding a Lambda, and writing one extra deployer validation pass. It does not invalidate this plan.

## Out of POC scope (build in Phase 2 or later)

- Multi-AZ spread.
- Pre-allocated EIP pool with deterministic vendor-facing IPs.
- Conntrack tuning in user-data.
- Cluster-wide port-collision validation across namespaces.
- Egress NIC throughput / conntrack saturation monitoring.
- Failure runbooks for AZ outage, node replacement, EIP exhaustion.
- Cilium egress gateway (truly per-pod IPs) — only if per-node granularity ever bites.
- NAT-instance pair fallback for "vendor demands a single fixed IP" — only if vendor policy changes.
- Cross-region failover.
- Egress quotas / per-app rate limits.
- Closed-egress NetworkPolicies for stable-egress namespaces.

## Out of plan scope (not stable-egress problems)

- UDP ingress (apps acting as UDP servers: game servers, VPN endpoints).
- Stable egress for agent runner pods or one-off jobs. The plan targets deployed app services.
- Per-app dedicated EIPs (would require Cilium egress gateway or per-pod ENI tricks).

## Implementation

### Platform repo (`eve-horizon-2`)

`packages/shared/src/schemas/manifest.ts` — extend `ServiceXeveSchema`:

```ts
export const ServiceNetworkingSchema = z.object({
  egress: z.enum(['nat', 'stable']).default('nat'),
}).passthrough();

// inside ServiceXeveSchema:
networking: ServiceNetworkingSchema.optional(),
```

The annotation on `ServiceXeveSchema` may need `: z.ZodTypeAny` to keep the outer `ManifestSchema` type inference under TS's serialization limit. Confirmed during v1 work.

`packages/shared/src/config/schema.ts` — add the compute-model marker the deployer branches on. Use the broader enum from `app-compute-classes-plan.md` so the two plans do not fight over config shape. Defaults below mean the deployer needs zero extra worker-side wiring for the stable-egress label/taint convention; the worker overlay only needs to keep `EVE_COMPUTE_MODEL=eks` (already set today).

```ts
EVE_COMPUTE_MODEL: z.enum(['k3s', 'gke', 'eks', 'aks', 'ecs']).default('k3s'),
EVE_STABLE_EGRESS_NODE_LABEL_KEY: z.string().default('eve.io/egress-pool'),
EVE_STABLE_EGRESS_NODE_LABEL_VALUE: z.string().default('stable'),
EVE_STABLE_EGRESS_TAINT_KEY: z.string().default('eve.io/egress-pool'),
EVE_STABLE_EGRESS_TAINT_VALUE: z.string().default('stable'),
EVE_STABLE_EGRESS_TAINT_EFFECT: z.enum(['NoSchedule', 'PreferNoSchedule', 'NoExecute']).default('NoSchedule'),
```

`apps/worker/src/deployer/deployer.service.ts` — three new helpers + injection in `renderManifest`:

- `resolveServiceNetworking(service)` and `requiresStableEgress(service)` — same shape as v1.
- `planStableEgressInjection(service, name)` returns one of:
  - `null` — not opted in.
  - `{ mode: 'noop' }` — non-EKS compute model. Logged as a warning.
  - `{ mode: 'eks', nodeSelector, tolerations, appEnv, hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet' }` — opted in on EKS.

In `renderManifest`, when injection mode is `eks`:

- Merge the toleration into `pod.spec.tolerations` (do not replace an existing list — managed-DB trust and other future features may add their own).
- Set `pod.spec.nodeSelector` (merge with any keys already populated by other deployer features — do not silently drop app-placement selectors if that plan has landed). Current manifests do not expose raw pod `nodeSelector`; if a future manifest placement field exists, incompatible selectors must fail at render time.
- Set `pod.spec.hostNetwork: true` and `pod.spec.dnsPolicy: 'ClusterFirstWithHostNet'`.
- Append `EVE_NETWORK_EGRESS=stable` to the app container env.
- Do **not** add startup probes, secrets, sidecars, or extra volumes.
- Phase 1 fail-fast: reject `networking.egress: stable` when the resolved service replica count is greater than 1. Multi-replica hostNetwork services require anti-affinity / cluster-wide port validation and are Phase 2 work.
- Phase 1 fail-fast: reject stable-egress service ports in the Kubernetes NodePort range (`30000-32767`) because the current EKS node SG allows that range from `0.0.0.0/0` for NLB traffic.
- If generic app placement from `app-compute-classes-plan.md` lands before this, stable-egress placement must not emit mutually exclusive selectors. Either stable-egress takes precedence over generic app placement, or the egress node group is also labeled with the generic app selector while retaining the egress-specific taint.

No fail-fast on missing config — there's no auth key to be missing. The only failure mode is "service opted in but no egress node group exists in the cluster," which surfaces as a stuck-Pending pod with a clear `eve.io/egress-pool` selector unsatisfied event. That's good UX.

`apps/worker/src/deployer/__tests__/deployer-stable-egress.spec.ts` covers:

- Schema accepts `networking.egress: stable` and rejects unknown values.
- Default services render unchanged.
- EKS + opted in injects `hostNetwork: true`, `dnsPolicy: ClusterFirstWithHostNet`, the node selector, the toleration, the app env.
- Pod has exactly one container (no sidecar) and no extra volumes.
- No Secret is emitted in the rendered docs.
- Existing pod-level fields populated by other deployer features (for example generic app placement) merge, don't get clobbered.
- k3d / unset compute model logs and renders no injection.
- Stable egress with replicas > 1 fails render in Phase 1.
- Stable egress with a declared service port in `30000-32767` fails render.

### Infra repo (`deployment-instance-repo`)

Replace the existing v1 Tailscale stable-egress wiring; do not run both designs at the same time. Remove the old EC2 exit-node module wiring, `tailscale_*` variables, `kubernetes_secret_v1.eve_stable_egress_client`, worker overlay `EVE_STABLE_EGRESS_EXIT_NODE` / `EVE_STABLE_EGRESS_TS_AUTHKEY` env vars, old outputs, and stale `terraform.tfvars.example` comments.

New module `terraform/aws/modules/eks-egress-pool/`:

- **One EKS managed node group**, public subnets only.
- Variables (POC defaults in parens):
  - `cluster_name` — `module.eks[0].cluster_name`
  - `node_role_arn` — `module.eks[0].node_role_arn`
  - `node_security_group_id` — `module.eks[0].node_security_group_id`
  - `subnet_ids` — list of public subnet IDs (POC: 1-element list pinned to eu-west-1b)
  - `capacity_type` (`"ON_DEMAND"`)
  - `min_size` (1), `max_size` (1), `desired_size` (1)
  - `instance_types` (`["t3.medium"]`)
  - `name_prefix` (inherits from root)
  - `node_label_key` / `node_label_value` (`eve.io/egress-pool` / `stable`)
  - `node_taint_key` / `node_taint_value` / `node_taint_effect` (`eve.io/egress-pool` / `stable` / `NO_SCHEDULE` for Terraform's EKS API value; Kubernetes renders this as `NoSchedule`)
- **Launch template** with public-IP association enabled so each instance gets an AWS-allocated public IP. If this uses a `network_interfaces` block, attach the shared node SG there and avoid combining it with top-level `vpc_security_group_ids` if Terraform/AWS rejects that shape.
- User-data: none in Phase 1. Let EKS managed node groups handle bootstrap. Phase 2 can add carefully merged pre-bootstrap sysctl user-data for conntrack tuning.

Root wiring:

- New variable `stable_egress_enabled` (default `false`). When true, the module is created.
- New variable `stable_egress_subnet_ids` (default `null` → defaults to `[module.network.public_subnet_ids[1]]`, the existing eu-west-1b convention used by the GPU/agent PV pin).
- New variable `stable_egress_instance_types` (default `["t3.medium"]`).
- New variable `stable_egress_capacity_type` (default `"ON_DEMAND"`).
- New variables `stable_egress_min_size`, `stable_egress_max_size`, `stable_egress_desired_size` (POC defaults all 1).
- Output `stable_egress_node_group_name` for ops visibility.

**No K8s Secret needed.** **No new worker overlay env changes needed** beyond the existing `EVE_COMPUTE_MODEL=eks`; remove the stale v1 Tailscale env bindings as part of the infra cleanup above.

`scripts/stable-egress/udp-diag.py` — keep the helper, but fix the STUN probe to reuse one local UDP socket across all STUN destinations before trusting its NAT classification.

## Verification Loop (against staging)

Step numbering is preserved from v1 so the plan reads as a continuation. Steps 0, 4, 5, 7, 8 are unchanged in intent. Steps 1, 2, 3, 6 swap in hostNetwork specifics.

### Staging Safety Pre-Flight

```bash
./bin/eh status                                # Staging Owner: true required
cd ../deployment-instance && ./bin/eve-infra kubeconfig doctor

# For unavoidable kubectl, from eve-horizon-2:
KUBECTL="kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
  --context <explicit-eks-context>"
```

Do not use `~/.kube/eve-hosted.yaml` or implicit kube context.

### Step 0 — Re-confirm the bug exists

```bash
$KUBECTL -n eve-example-camera-poller-sandbox cp \
  ../deployment-instance/scripts/stable-egress/udp-diag.py \
  sandbox-api-7cb59db69-kc27t:/tmp/udp-diag.py -c api
$KUBECTL -n eve-example-camera-poller-sandbox exec sandbox-api-7cb59db69-kc27t -c api \
  -- python3 /tmp/udp-diag.py
```

Expected with the corrected same-socket diagnostic: egress IP is the cluster NAT GW EIP, vendor relay still times out, and the same local UDP socket receives destination-dependent mapped ports across STUN servers. If the same-socket STUN mappings are already endpoint-independent, stop and re-diagnose the camera-poller failure before building stable egress.

### Step 1 — Provision the egress node group

```bash
cd ../deployment-instance/terraform/aws
# In terraform.tfvars:
#   stable_egress_enabled = true
# (POC defaults handle the rest.)
terraform fmt -recursive
terraform plan
terraform apply
terraform plan        # must show no changes
```

Expected: a new managed node group with one t3.medium in eu-west-1b, public IP attached, label `eve.io/egress-pool=stable`, taint `eve.io/egress-pool=stable:NoSchedule`. Final plan shows no drift.

```bash
$KUBECTL get nodes -l eve.io/egress-pool=stable -o wide
```

Expected: one Ready node with an `EXTERNAL-IP` populated.

Stop if the node has no `EXTERNAL-IP` — public IP attachment isn't working and the rest of the loop will report misleading results.

### Step 2 — Validate the node's public path

```bash
NODE_NAME="$($KUBECTL get nodes -l eve.io/egress-pool=stable \
  -o jsonpath='{.items[0].metadata.name}')"
NODE_IP=$($KUBECTL get nodes -l eve.io/egress-pool=stable \
  -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}')
echo "egress node = $NODE_NAME"
echo "egress node external IP = $NODE_IP"
$KUBECTL get node "$NODE_NAME" -o wide
```

Expected: the node is `Ready` and has an `EXTERNAL-IP` equal to `$NODE_IP`.

Stop if there is no `EXTERNAL-IP` — public IP attachment is not working and the rest of the loop will report misleading results. Do not rely on SSH for this check; EKS managed nodes are not guaranteed to have SSH access wired.

### Step 3 — Validate NAT semantics through a one-off pod

This proves the hostNetwork + nodeSelector pattern produces endpoint-independent NAT before we touch the platform code path or camera-poller.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: egress-test
  namespace: eve-egress-test
  labels: { app: egress-test }
spec:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet
  nodeSelector: { eve.io/egress-pool: stable }
  tolerations:
    - key: eve.io/egress-pool
      operator: Equal
      value: stable
      effect: NoSchedule
  containers:
    - name: app
      image: python:3.12-slim
      command: ["sh", "-c", "sleep 3600"]
      env:
        - { name: EVE_NETWORK_EGRESS, value: stable }
```

Then:

```bash
$KUBECTL create namespace eve-egress-test --dry-run=client -o yaml | $KUBECTL apply -f -
$KUBECTL apply -f egress-test.yaml
$KUBECTL -n eve-egress-test wait --for=condition=Ready pod/egress-test --timeout=120s
$KUBECTL -n eve-egress-test cp \
  ../deployment-instance/scripts/stable-egress/udp-diag.py egress-test:/tmp/udp-diag.py
$KUBECTL -n eve-egress-test exec egress-test -- python3 /tmp/udp-diag.py
```

Expected:
- `egress public IP` equals `$NODE_IP`, **not** the cluster NAT GW EIP (`52.215.97.195`).
- The corrected same-socket STUN probe returns the **same** external mapped `(IP, port)` across servers.
- UDP/53 still works.

If the public IP is still `52.215.97.195`, `hostNetwork: true` did not take effect. Check `kubectl get pod egress-test -o yaml | grep hostNetwork` and pod scheduling.

If same-socket STUN ports differ while the egress IP is correct, the public-node path still has destination-dependent mapping. This should not happen for host-originated traffic through the EC2 public IPv4 / IGW path — investigate before opting any app in.

### Step 4 — Cut a platform release

After the platform code and tests are merged on `main`:

```bash
cd ~/dev/eve-horizon/eve-horizon-2
LATEST="$(git tag --list 'release-v*' --sort=-version:refname | head -1)"
NEXT="$(echo "$LATEST" | awk -F. '{print $1"."$2"."$3+1}')"
git tag "$NEXT"
git push origin "$NEXT"
gh run watch --repo example-org/deployment-instance
eve system health --json | jq .status
```

Expected: `"ok"`.

### Step 5 — Opt camera-poller into stable egress

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

Verify the rendered pod:

```bash
$KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api -o yaml \
  | grep -E 'hostNetwork|egress-pool|dnsPolicy'
```

Expected: `hostNetwork: true`, `dnsPolicy: ClusterFirstWithHostNet`, `eve.io/egress-pool: stable` selector, matching toleration.

```bash
$KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api -o wide
```

Expected: pod is on the egress node identified in Step 2.

### Step 6 — Re-run the diagnostic from inside camera-poller

```bash
POD="$($KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api \
  -o name | head -1)"
$KUBECTL -n eve-example-camera-poller-sandbox cp \
  ../deployment-instance/scripts/stable-egress/udp-diag.py \
  "${POD#pod/}:/tmp/udp-diag.py" -c api
$KUBECTL -n eve-example-camera-poller-sandbox exec "${POD#pod/}" -c api \
  -- python3 /tmp/udp-diag.py
```

Expected:
- `egress public IP` equals `$NODE_IP`, **not** `52.215.97.195`.
- The corrected same-socket STUN probe returns the **same** external mapped `(IP, port)` across servers.

If symmetric NAT is still observed, the deployer didn't actually inject `hostNetwork: true`. Check the rendered Deployment YAML and the deployer logs.

### Step 7 — Real handshake check

```bash
eve env logs proj_example sandbox api --tail 100 --follow
```

Trigger the camera poller (it runs every 300 s; force one with the app's manual-poll endpoint if available).

Expected:
- Relay attempt succeeds instead of timing out.
- Camera frame count increases in the app database.

If STUN passes but the relay still times out, the platform egress behavior is correct and the remaining issue is app/vendor-specific.

### Step 8 — Rollback dry run

Confirm the feature can be disabled per app:

```bash
# Revert the manifest to omit networking.egress
eve env deploy proj_example sandbox
$KUBECTL -n eve-example-camera-poller-sandbox get pod -l eve.component=api -o yaml \
  | grep -E 'hostNetwork|egress-pool' || echo "no stable-egress markers (expected)"
```

Expected: no `hostNetwork`, no `egress-pool` selectors. Pod is back on a default app node.

Then re-enable `networking.egress: stable` and redeploy so staging is left in the working state.

## Acceptance

The plan is shipped when:

- [ ] Step 3 proves the one-off hostNetwork pod exits through the egress node's public IP with endpoint-independent STUN mappings.
- [ ] Step 6 proves the camera-poller pod (after Step 5 opt-in) does the same.
- [ ] Step 7 shows the relay handshake completing and frames flowing.
- [ ] Step 8 toggles cleanly in both directions.
- [ ] `scripts/stable-egress/udp-diag.py` uses one local UDP socket across STUN destinations and prints the local/mapped port comparison.
- [ ] Three unrelated staging apps show no deploy-manifest churn after the platform release.
- [ ] `references/manifest.md` in `eve-skillpacks` documents `x-eve.networking.egress`.
- [ ] `references/deploy-debug.md` in `eve-skillpacks` documents stable egress diagnostics.

## Risks and Follow-Ups

### POC risks (accepted)

- **Node replacement = IP change.** AWS-assigned public IP is tied to the instance. Node replacement, recycle, or upgrade gives the new node a different IP. Tolerable for camera-poller-class workloads (STUN-discovered, auto-reconnect). Documented limitation. Phase 2 EIP pool fixes this.
- **Single AZ dependency.** AZ outage takes camera-poller offline. Acceptable for POC; Phase 2 AZ-spread fixes it.
- **`hostNetwork: true` exposes containerPorts on the node IP.** The current node SG allows the Kubernetes NodePort range from the Internet for NLB traffic, so Phase 1 must reject stable-egress service ports in `30000-32767`. Other app ports are not intentionally opened by the node SG. Document this in the manifest reference so anyone adding a second stable-egress service is warned.
- **NetworkPolicy doesn't apply** to hostNetwork pods. Pre-MVP this is moot (open-by-default posture). Surfaces only when closed-egress NetworkPolicies are introduced.
- **No port-collision validation across services.** With one app, not a concern. Phase 2 adds a cluster-wide validator in the deployer.

### Production-readiness gaps (Phase 2 work, separate plan)

- Pre-allocated EIP pool for deterministic vendor-facing IPs.
- AZ-spread across ≥2 AZs.
- Conntrack tuning + saturation alerts.
- Cluster-wide port-collision validation in the deployer.
- Egress NIC throughput + SG drop alerts.
- Failure runbooks (AZ out, node replacement, EIP exhaustion).
- Capacity planning around `net.netfilter.nf_conntrack_max`.
- Tested AZ-failover with measured camera-poller recovery time.

### Future divergence (defer until needed)

- **Vendor demands single fixed IP**: introduce active/standby NAT-instance pair, route public-subnet nodes through it. Migration is a route-table change, not a re-architect.
- **Per-pod IP granularity required**: switch to Cilium egress gateway. Cluster-wide CNI change; defer until a real driver appears.

## Sister-plan deltas (what changes in adjacent docs after this lands)

- `eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` documents `x-eve.networking.egress`.
- `eve-skillpacks/eve-work/eve-read-eve-docs/references/deploy-debug.md` replaces the current v1 Tailscale sidecar section with stable egress diagnostics for the v2 hostNetwork flow.
- This plan supersedes `app-stable-egress-plan.md` (v1). The v1 plan stays in-tree as historical record; a banner note at the top of v1 will point readers here.

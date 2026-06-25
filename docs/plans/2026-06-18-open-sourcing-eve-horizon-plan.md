# Open-Sourcing Eve Horizon — Plan

> **Status**: Proposed · **Created**: 2026-06-18 · **Last updated**: 2026-06-23 · **Owner**: Project maintainers
> **License target**: **MIT, everywhere** (platform, services, SDKs, infra, examples, docs)
> **Copyright holder**: **Adam Chesney and Incept5**

This plan covers everything required to release the Eve Horizon platform and its
satellite repositories as open source under the **MIT License**. It is grounded in a
multi-track audit (secrets, internal coupling, dependency licenses, repo classification,
infra-template review) run 2026-06-18 and extended 2026-06-23.

---

## 1. TL;DR

We open-source **~10 repositories across two GitHub orgs** (`the platform operator` and the neutral
`eve-horizon`). Several are **already public** — so for those the work is *licensing +
sanitizing in place*, not flipping visibility. The dependency tree is 100% permissive
(zero copyleft) — there are **no license blockers**. The work is hygiene and de-risking.

**One hard leak blocker** (a second was investigated and cleared):
1. The **already-public** `eve-horizon-infra` template ships the platform operator's **live staging
   config** in its default `aws` overlay (real Elastic IPs, AWS account ID in an IRSA
   ARN, `eve.example.com` hosts/buckets) — and currently has **no license** (so it's
   legally "all rights reserved" while sitting public).
2. ~~A live Slack bot token in `eve-horizon` history~~ — **CLEARED 2026-06-23.** The doc
   contains only a **truncated 15-char prefix** (`xoxb-REDACTED`) of a 58-char token;
   the full value was **never committed to any blob in history**. Not exploitable, not a
   real credential leak. Downgraded to a one-line cosmetic redaction (§5.1). No rotation
   or history scrub needed.

**The five workstreams:**
1. **Secrets & leak remediation** — genericize the infra template's default overlay + TF
   backend; genericize the AWS account ID and personal email across repos; redact the
   truncated Slack-token prefix from one doc. (No live secret in history — see §5.1.)
2. **License & attribution** — **MIT `LICENSE`** at every repo root (and per-package for
   npm); `"license": "MIT"` in every `package.json`; a `THIRD_PARTY.md` for the bundled
   agent CLIs.
3. **Decoupling & public docs** — self-contained local quickstart; the `eve-horizon-infra`
   template now *resolves* the old "dangling infra" gap (it's the public deploy scaffold).
4. **Community & governance** — `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`,
   `TRADEMARKS`; optional DCO; issue/PR templates; branch protection.
5. **Consolidate & publish** — consolidate the two starter templates; flip the still-private
   repos public; pre-flip `gitleaks`/`trufflehog` gate on every repo (incl. the already-public ones).

**Effort estimate:** ~2–3 focused engineering days, dominated by the `eve-horizon`
monorepo and the `eve-horizon-infra` overlay genericization.

---

## 2. Goals & non-goals

**Goals**
- Release Eve Horizon as a coherent, self-hostable open-source agentic PaaS.
- **MIT** across the board — simplest, most permissive, consistent.
- Copyright attributed to **Adam Chesney and Incept5**.
- Zero secrets in any published working tree or git history.
- A public reader can clone, `pnpm install`, run the stack locally, **and deploy** to
  their own cloud using the public `eve-horizon-infra` template — with no access to
  the platform operator private infrastructure.
- Clean attribution for all third-party code and bundled tools.

**Non-goals**
- Open-sourcing `deployment-instance-repo` (the platform operator's private *deployment instance* — out of scope).
- Open-sourcing the predecessor `eve` / `eve-source` (proprietary license, different architecture).
- Open-sourcing `eden` or `eve-pm` in this plan (handled separately — see §3.3).
- Re-architecting the platform. The three-repo deploy model stays; we *document* it and
  ship a clean local path + the public infra template.

---

## 3. Repository audit & scope decisions

The ecosystem spans **two GitHub orgs**: `the platform operator` (company org, mostly private) and
`eve-horizon` (neutral org, **already public**). A clean OSS presence likely wants
everything under the neutral `eve-horizon` org eventually (see §12 org-consolidation note),
but that move is optional and can follow the release.

### 3.1 INCLUDE — ship under MIT in this release

| Repo | Org | Currently | Role | Key work |
| --- | --- | --- | --- | --- |
| **eve-horizon** | the platform operator | **private** | Platform monorepo (6 services + SDKs + CLI) | Slack-token scrub; AWS-id/email genericize; LICENSE; flip public. **Most work here.** |
| **eve-horizon-infra** | eve-horizon | **public, template** | Public deploy scaffold (k8s, terraform, `bin/eve-infra`) | Add LICENSE (urgent); genericize default `aws` overlay + TF backend. |
| **eve-horizon-starter** | the platform operator | **private** | Canonical `eve init` starter | Fix false "MIT" README ✓→actual LICENSE; flip public; absorb `eve-quickstart`. |
| **eve-quickstart** | eve-horizon | **public** | *Duplicate* "Eve Horizon Starter" | **Consolidate** → archive + README redirect to canonical starter. |
| **eve-horizon-fullstack-example** | the platform operator | **private** | Canonical full-stack example app | LICENSE; flip public. Intentional demo secrets stay. |
| **eve-horizon-showcase** | the platform operator | **private** | Marketing/docs SPA, deployed via Eve | LICENSE; flip public. Clean. |
| **eve-software-factory** | the platform operator | **private** | AgentPack example (PM→Planner→Coder→Verifier→PR) | LICENSE; flip public. Clean. |
| **ingest-agentpack** | eve-horizon | **public** | AgentPack example (doc ingestion) | Add LICENSE. Clean. |
| **learning-loop-agentpack** | eve-horizon | **public** | AgentPack example (learning loop) | Add LICENSE. Clean. |
| **eve-skillpacks** | the platform operator | **private** | Public skill packs agents read to learn Eve | Scrub AWS ARN; blank `.eve/profile.yaml`; LICENSE; flip public. |
| **eve-horizon-docs** | eve-horizon | **public, MIT** | Human-facing docs site | Already MIT — confirm copyright line, minimal work. |

> Of these, **6 are already public** (`eve-horizon-infra`, `eve-quickstart`, `ingest-agentpack`,
> `learning-loop-agentpack`, `eve-horizon-docs`) — for them this is *license + sanitize in place*.
> Only `eve-horizon`, `eve-horizon-starter`, `eve-horizon-fullstack-example`, `eve-horizon-showcase`,
> and `eve-software-factory` need an actual private→public flip.

### 3.2 EXCLUDE — do not publish

| Repo | Reason |
| --- | --- |
| **deployment-instance-repo** (the platform operator) | Private *deployment instance* of the infra template. Holds the platform operator's real cloud config. Out of scope. |
| **eve** (the platform operator) | Predecessor product (single-server agent IDE). **Proprietary** "Custom License". Different architecture. |
| **eve-source** (the platform operator) | Source of the predecessor; proprietary "non-commercial" license. Shares no runtime architecture. |
| **eve-horizon-dashboard** (the platform operator) | Superseded by the in-monorepo `eve-horizon/apps/dashboard` (rebuilt 2026-06-12). Dead fork of the starter. |
| **eve-horizon-planning** (local) | Local-only planning scratch (no remote, 9.2 GB). Internal. |

> ⚠️ **Guardrail:** `eve` and `eve-source` carry committed *proprietary* license terms. A
> bulk "make repos public" action must **not** sweep them in. Relicensing them would
> require an affirmative legal decision and is out of scope here.

### 3.3 DEFERRED / SEPARATE DECISION — public+unlicensed, handle outside this plan

| Repo | Org | State | Note |
| --- | --- | --- | --- |
| **eden** | eve-horizon | **public, no license** | "Eden — AI-First Requirements Platform": a substantive, *active* app built on Eve (259 commits). Potential commercial product. **Per decision: handle separately.** But it is public with no license today (= all rights reserved) — needs its own licensing/product decision regardless. Flag to owner. |
| **eve-pm** | the platform operator | private | Substantive product (926 MB, 161 commits) built on Eve. Held back as a potential commercial product. Revisit later as a "flagship app on Eve" showcase. |

---

## 4. License strategy

### 4.1 MIT everywhere (decided)

- **One license — MIT — for all published repos** (platform, services, SDKs, CLI, infra
  template, examples, AgentPacks, docs). Simplest possible story: maximally permissive,
  no copyleft, no patent/NOTICE machinery, trivial for forkers and app developers.
- **Copyright line everywhere:** `Copyright (c) 2026 Adam Chesney and Incept5`.
- The five client SDK/CLI packages already declare `"license": "MIT"` — now consistent
  with everything else (no longer an exception).
- **No more mixed-license monorepo complexity.** Every `package.json` → `"license": "MIT"`;
  every repo root → a single MIT `LICENSE`. The five npm-published packages additionally
  carry their own `packages/<pkg>/LICENSE` (MIT) so the text travels with the package.
- `eve-horizon-docs` is already MIT — only the copyright line needs reconciling to the
  dual holder.

> **Why MIT over Apache 2.0** (the earlier target): the owner prefers the more liberal,
> lower-ceremony license. MIT drops Apache's NOTICE-propagation and explicit patent grant.
> For this project the simplicity and permissiveness win; the lack of an explicit patent
> grant is an accepted trade-off.

### 4.2 Dependency-license compatibility — VERDICT: CLEAR ✅

A scan of all 1,221 installed packages under `node_modules/.pnpm` plus the lockfile found
**zero copyleft or restrictive licenses**. Distribution (approx): 492 MIT, 48 ISC,
38 Apache-2.0, 17 BSD-3, 14 BSD-2, 7 BlueOak-1.0.0, 6 Unlicense, plus single permissive
outliers (0BSD, MIT-0, Python-2.0, CC-BY-4.0 *data*, `json-schema` dual → elect BSD-3).
All are one-way compatible with shipping our code under MIT. No vendored/copied
third-party source exists outside `node_modules` (header scan returned zero foreign
license headers).

### 4.3 Bundled agent CLIs — attribution courtesy (not a source-license issue)

The 6 harnesses (`@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, and
`cc-mirror`, which mints the `mclaude`/`zai` variants) are **not** in the source tree or
any published npm package. They are `npm install -g`'d at **Docker image build time** in
`apps/worker/Dockerfile` and `apps/agent-runtime/Dockerfile`, gated behind
`INSTALL_CLAUDE` / `INSTALL_CODEX` / `INSTALL_GEMINI` build args (default `true`).

- Our MIT **source** is unaffected — we don't redistribute these tools in the repo.
- Our published **container images** (`ghcr.io/eve-horizon/*`) *do* contain them; each
  carries its own license + provider ToS (often requiring an account/API key).
- **Action:** add a `THIRD_PARTY.md` to `eve-horizon` listing the bundled CLIs and their
  licenses; confirm `cc-mirror`'s npm license before relying on it in published images;
  keep the build-arg opt-out so a "clean" image can be built without them. (MIT imposes no
  NOTICE-propagation duty — this is courtesy/clarity, not obligation.)

---

## 5. Security & secrets remediation

### 5.1 ~~BLOCKER~~ → NICE-TO-HAVE (cosmetic) — Slack-token prefix (eve-horizon)

**Re-investigated 2026-06-23 — downgraded from BLOCKER to cosmetic redaction.**

- **Where:** `docs/issues/slack-file-download-gets-login-page-html.md:22` — a table row
  annotated "**real, verified working**" describing a 58-char `xoxb-…` token (workspace
  `T088AQ3D9FX`; integration `intg_01kk9hb91hfzvvewxxk0wp56wz`).
- **Why it's NOT a blocker:** the doc contains only a **15-char truncated prefix**
  (`xoxb-REDACTED`, 1 dash + literal `...`), not the token. The annotation describes the
  real token's properties; only a prefix was pasted. A full-history blob scan
  (`git cat-file` over every object) found the full-structure token (`xoxb-N-N-…24+chars`)
  in **zero commits**. The secret entropy (final 24-char segment) is entirely absent.
  A prefix cannot authenticate and is not brute-forceable.
- **Therefore:** **no rotation** and **no history scrub** are required for this. The live
  token remains valid on staging (stored in Eve's DB `integrations.tokens_json.bot_token`)
  and is unaffected.
- **Action (cosmetic, do before publish):** replace the prefix + the two integration IDs in
  the doc with `xoxb-<redacted>` / `intg_<redacted>` so `gitleaks` doesn't flag the `xoxb-`
  pattern. One-line working-tree edit; no history rewrite. (Optional belt-and-suspenders:
  rotate via the OAuth reinstall flow — `eve integrations slack connect --org org_example`
  — but not necessary.)
- **Severity:** NICE-TO-HAVE.

### 5.2 BLOCKER (already-public) — the platform operator instance config in the `eve-horizon-infra` template

The template is **already public** and is a GitHub template repo, but its **default `aws`
overlay is the platform operator's live staging instance**, and the repo has **no license**. No
credentials/state/kubeconfigs are committed (history is clean) — but this exposes the
production instance and undermines the "generic template" purpose. Fix in place, urgently.

> ✅ **IMPLEMENTED 2026-06-23** — all three tiers below + the MIT LICENSE done on branch
> `chore/genericize-aws-overlay-and-license` (commit `0095a8f`), **not yet pushed** (awaiting
> review of an already-public repo). 17 files: `aws` overlay genericized to the `aws-eks`
> `*.eve.example.com` / `REPLACE_*` convention; TF backend converted to partial config
> (`backend.hcl.example` + gitignore); bootstrap module derives names from
> `name_prefix`+account-id; Tier-2/3 var defaults, comments, and `docs/plans/terraform-remote-state.md`
> genericized (real account id → `<aws-account-id>`, `example-*` → `eve-hosted-*`); added MIT
> `LICENSE` + `SECURITY.md` + fixed README license section. Repo-wide grep confirms zero
> remaining real values (only the intentional `security@example.com` contact).
> **Pre-existing issue found (separate):** `kustomize build` can't run standalone because
> `k8s/base/kustomization.yaml` + the `aws` overlay reference deploy-time-generated files
> (`auth-bootstrap-configmap.yaml`, `mailpit-*.yaml`, `cluster-issuer.yaml`) absent from
> `origin/main`. A public user running `kustomize build` would hit this — track + fix separately.

| Item | Where | Action |
| --- | --- | --- |
| Real Elastic IPs `52.209.1.195,52.17.16.223` | `k8s/overlays/aws/{api,worker}-deployment-patch.yaml` (`EVE_PLATFORM_INGRESS_IP`) | Replace with `REPLACE_INGRESS_IP` placeholder. |
| AWS account ID in IRSA ARN `arn:aws:iam::<aws-account-id>:role/example-api-irsa` | `k8s/overlays/aws/api-serviceaccount-patch.yaml:7` | Use `REPLACE_API_IRSA_ROLE_ARN` (mirror the clean `aws-eks` overlay). |
| `eve.example.com` hosts + `example-eve-*` buckets | `k8s/overlays/aws/*` (api/worker patches, ingress patches) | Genericize to `*.eve.example.com` / `REPLACE_*`. |
| TF state backend hardcoded `bucket = example-terraform-state-<aws-account-id>`, `dynamodb_table = example-tf-lock` | `terraform/aws/providers.tf:7-10`, `terraform/aws-backend/main.tf:23` | Convert to partial backend config supplied at `terraform init` time. |
| Account ID / ARNs in design docs | `docs/plans/terraform-remote-state.md` (worst), `ses-feedback.tf:65`, `variables.tf:400` | Genericize (NICE-TO-HAVE; cosmetic, not secrets). |

> The `aws-eks` and `gcp` overlays already do this correctly (`api.eve.example.com`,
> `REPLACE_REGISTRY_IRSA_ROLE_ARN`) — make the default `aws` overlay match them, and point
> `config/platform.yaml` at a clean default.

### 5.3 SHOULD-FIX — AWS account ID `<aws-account-id>` (eve-horizon + skillpacks)

- ~21 tracked files in `eve-horizon` (e.g. `apps/orchestrator/src/cron/cloud-cost-collector.service.ts`,
  `bin/eh-commands/_kube_guard.sh`, `AGENTS.md`, `tests/manual/seed-demo-costs.sql`, many
  `docs/plans/*`/`docs/reports/*`), plus `eve-skillpacks/.../references/overview.md` (a
  private-cluster-ops section, ~lines 64–69).
- **Action:** parameterize via `EVE_AWS_ACCOUNT_ID` in code; replace with
  `<your-aws-account-id>` in docs (test specs already use dummy `<aws-account-id>`); **remove**
  the private-cluster ops section from the skillpacks `overview.md`.

### 5.4 SHOULD-FIX — personal email & internal identifiers

- `admin@example.com` in `.eve/profile.yaml` (`default_email`) + ~22 tracked files.
- `eve-skillpacks/.eve/profile.yaml` pins real `org_example` / a real `proj_…` id.
- **Action:** blank/genericize `.eve/profile.yaml` in both repos; replace the personal Gmail
  with a role/contact address in docs.

### 5.5 SHOULD-FIX — tracked `.env.test` keypair (eve-horizon)

- `.env.test` (intentionally tracked) contains a literal `-----BEGIN PRIVATE KEY-----` PEM
  (`EVE_AUTH_PRIVATE_KEY`) + `EVE_SECRETS_MASTER_KEY="test-master-key"`. All **dummy test
  fixtures**, unchanged since the initial auth commit.
- **Action:** human-confirm it's a throwaway (it is), add a `# TEST-ONLY fixture — not a
  real secret` header, and add a `gitleaks` allowlist entry for the path. (Or generate the
  test keypair at test-setup time.)

### 5.6 SHOULD-FIX — internal-only tracked directories (eve-horizon)

| Path | Tracked | Decision |
| --- | --- | --- |
| `private-eve-dev-skills/` | 22 files | **Exclude.** Internal ops runbooks carrying the AWS account ID + infra coupling. `git rm` from the published tree; keep privately. |
| `.beads/` (incl. `issues.jsonl` ~992 KB) | 8 files | **Default EXCLUDE.** Internal task tracker w/ personal email + `deployment-instance-repo` refs. Continue beads privately. |
| `magic-link-fail.png` (root) | 1 | Remove — stray debug screenshot. |
| `CLAUDE.md`, `AGENTS.md` | 2 | **Keep but sanitize** — strip AWS account ID, staging hostnames, staging-owner ops detail. |
| `workspaces/`, `graphify-out/`, `tmp/`, `.playwright-mcp/`, `node_modules/`, `.claude/`, `.agent*/`, … | untracked (gitignored) | No action — confirm `.gitignore` coverage before flip. |

### 5.7 Satellite repos — secret status

- **eve-skillpacks**: history clean. An *untracked, gitignored* `secrets.env` holds a real
  GitHub PAT on disk — **rotate it** (hygiene). Fix AWS-ARN leak (§5.3) + blank profile (§5.4).
- **eve-horizon-starter**: clean. Fix false "MIT" README → real MIT `LICENSE`.
- **eve-horizon-fullstack-example**: clean. `.eve/dev-secrets.yaml` is *intentional* demo
  values — leave as-is.
- **eve-horizon-showcase**: clean (`env.secrets` gitignored/untracked, no tokens).
- **eve-software-factory / ingest-agentpack / learning-loop-agentpack**: clean (YAML/markdown only).
- **eve-horizon-docs**: already public + MIT; quick scan clean.

### 5.8 Pre-flip secret-scan gate (ALL repos, incl. already-public ones)

```bash
gitleaks detect --source . --redact -v
trufflehog git file://. --only-verified
```
Configure `.gitleaks.toml` to allowlist known-safe fixtures (`.env.test`, `*.example`,
demo `dev-secrets.yaml`). Run on **full history** of every repo before declaring done.

---

## 6. License & attribution artifacts (per repo)

For **every** published repo:

1. **`LICENSE`** at root — full **MIT** text, `Copyright (c) 2026 Adam Chesney and Incept5`.
   The five npm packages additionally get `packages/<pkg>/LICENSE` (MIT) so the text ships
   with the package.
2. **`package.json` `license` field** = `"MIT"` everywhere:
   - Add to all `@eve/*` services/tools currently missing it (`@eve/api`, `@eve/orchestrator`,
     `@eve/db`, `@eve/migrate`, `@eve/shared`, `@eve/agent-runtime`, `@eve/gateway`, `@eve/sso`,
     `@eve/worker`, `@eve/dashboard`, `@eve/eve-agent-cli`, root `eve-horizon`).
   - The five SDK/CLI packages already say `MIT` — no change.
3. **README license section** — fix `eve-horizon` README:428 ("Proprietary - the platform operator") and
   `eve-horizon-starter` README:369 ("MIT" text but no LICENSE file) to reference the MIT
   `LICENSE`. Update `eve-horizon-infra` README:136-138 (dangling "see the project for
   terms" → MIT). Reconcile `eve-horizon-docs` copyright to the dual holder.
4. **Per-file headers — SKIP (recommended).** Root `LICENSE` + per-package `license` field
   is the TS/JS-monorepo norm; MIT doesn't require headers. If ever wanted, apply an MIT
   header (Appendix A) via `addlicense`/`license-check-and-add`, scoped to `apps/**` +
   `packages/**` only.
5. **`THIRD_PARTY.md`** (eve-horizon) — list bundled agent CLIs + licenses (§4.3).
6. **`NOTICE`** — *optional* under MIT. Skip unless desired; a short `THIRD_PARTY.md` covers
   attribution courtesy.
7. **`private: true` audit** — add to any `@eve/*` package not meant for npm; reconcile
   `@eve/migrate` (published via `publish-migrate.yml` but has no `publishConfig.access`).
   Only `@eve-horizon/{auth,auth-react,chat,chat-react,cli}` should be publishable.

---

## 7. Decoupling & public-facing documentation

The three-repo deploy model is now **legible**, because the public `eve-horizon-infra`
template is in scope — it's the artifact that resolves the old "dangling `deployment-instance-repo`
references" gap. The job is to make both the **local** and **deploy** paths work for outsiders.

1. **Self-contained local quickstart.** Today's quickstart assumes k3d + `org_manualtestorg`
   + `manual-tests.secrets` + staging at `eve.example.com`. Add a public path:
   ```
   git clone … && pnpm install && ./bin/eh start docker   # → http://localhost:4801
   ```
   Mark clearly what's optional/internal.
2. **Document the deploy architecture as a pattern.** Point users at `eve-horizon-infra` as
   the public template; explain `gh repo create <org>/<name>-eve-infra --template
   eve-horizon/eve-horizon-infra` and the image-dispatch flow. The private `deployment-instance-repo`
   is just *the platform operator's instance of the template* — references to it become "your instance repo."
3. **Genericize hostnames/registry as documented defaults.** `eve.lvh.me` (local) stays.
   Replace `eve.example.com`/`example.dev` staging examples with `eve.example.com`-style
   placeholders or label them "the platform operator's hosted instance, shown as an example." Keep
   `ghcr.io/eve-horizon/*` as the canonical image namespace; document how a forker overrides it.
4. **Scrub internal ops detail** from public docs (staging-owner flags, `admin@example.com`
   as a literal admin identity → placeholder), per §5.

---

## 8. Community & governance artifacts

1. **`CONTRIBUTING.md`** — dev setup (`./bin/eh status`, `pnpm install/build/test`, test
   tiers), branch/PR flow, sign-off expectation.
2. **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1, with a contact address.
3. **`SECURITY.md`** — private disclosure via GitHub Private Vulnerability Reporting +
   `security@`-style address; supported versions; response SLA. Important for auth/RBAC/
   secrets-handling infra.
4. **Contributor sign-off → DCO (optional under MIT).** DCO (`git commit -s`) is cheap and
   nice-to-have; with MIT and a small team it's optional. If adopted, enforce via the DCO
   GitHub App / CI check and document in `CONTRIBUTING.md`.
5. **`TRADEMARKS.md`** — MIT (like Apache) grants **no** trademark rights. State that "Eve
   Horizon" and any logos are trademarks of the platform operator / Example Admin; describe acceptable
   nominative/fork use (forks must not imply endorsement and should rename if distributed as
   a product). Confirm `@eve-horizon` npm scope ownership.
6. **GitHub templates & settings** (at flip / sanitize time):
   - `.github/ISSUE_TEMPLATE/` (bug + feature YAML forms), `PULL_REQUEST_TEMPLATE.md`.
   - **Branch protection on `main`** (review + CI). The current "agents push directly to
     main" workflow must change for public repos.
   - Repo description, topics (`ai-agents`, `kubernetes`, `typescript`, `agent-runtime`,
     `llm`, `paas`), homepage.
   - **Fork-PR safety**: ensure no publish/deploy workflow (`publish-images.yml`,
     `publish-cli.yml`, infra `deploy.yml`) is triggerable by untrusted forks; avoid
     `pull_request_target`. Add a license-compliance CI gate
     (`license-checker --failOn 'GPL;AGPL;LGPL;SSPL;BUSL'`).

---

## 9. Execution phases & sequencing

> Do the one urgent item — `eve-horizon-infra` overlay genericization (§5.2) — **first**:
> it's a live leak in an **already-public** repo. (The Slack token is a non-issue, §5.1.)

| Phase | Scope | Gate to next |
| --- | --- | --- |
| **0. Prep** | Tracking epic + issues; confirm copyright string (`Adam Chesney and Incept5`); confirm `.env.test` key is throwaway; install `gitleaks`, `trufflehog`. | Decisions locked. |
| **1. Urgent leak remediation** | Genericize `eve-horizon-infra` default `aws` overlay + TF backend (already public!) + add its MIT LICENSE. Rotate skillpacks PAT (hygiene). | Already-public surfaces clean. |
| **2. eve-horizon secret cleanup** | Redact Slack-token prefix + integration IDs in doc; genericize AWS id + email; sanitize `CLAUDE.md`/`AGENTS.md`; `git rm` `private-eve-dev-skills/`, `.beads/`, `magic-link-fail.png`. | Working tree scanner-clean. |
| **3. License & attribution** | MIT `LICENSE` everywhere + per-package; `license` fields; fix README license sections; `THIRD_PARTY.md`; `private:true` audit. | All repos MIT-labelled. |
| **4. Decoupling & docs** | Self-contained quickstart; genericize hostnames/registry; document three-repo deploy via the public template; scrub internal docs. | Fresh clone runs + deploys with no private access. |
| **5. Governance** | `CONTRIBUTING`/`CODE_OF_CONDUCT`/`SECURITY`/`TRADEMARKS`; issue/PR templates; CI license gate; (optional DCO). | Governance files merged. |
| **6. Pre-flip scan** | Run `gitleaks`/`trufflehog` over **full history** of every repo. History rewrite NOT expected (§11) — only if the scan surfaces a real secret. | Scanners pass on full history. |
| **7. Consolidate & publish** | Consolidate starters (archive `eve-quickstart` → redirect to canonical `eve-horizon-starter`). Flip the 5 still-private repos public. Enable branch protection. Announce. | Repos public, CI green, scanners green. |
| **8. Post-launch** | Verify external clone+build+deploy on a clean machine; monitor issues. Optional: org consolidation (§12); resolve `eden`/`eve-pm` separately. | — |

---

## 10. Per-repo work breakdown (checklists)

### eve-horizon (the platform operator, private → public) — the bulk · 🟡 prep done on `main` (7 `oss-prep:` commits, latest `85b4a42b`), NOT yet flipped public
- [x] Redact Slack-token prefix + integration IDs + workspace id in the diagnosis doc (cosmetic; no rotation/scrub — §5.1)
- [x] Parameterize/redact AWS account id: source default → env-driven (`EVE_AWS_COST_ACCOUNT_ID`), `_kube_guard.sh` → env, docs/tests → `<aws-account-id>`
- [x] Genericize personal/team emails (`@example.com`, gmail test names) → `@example.com`; untrack + gitignore `.eve/profile.yaml`
- [x] Untrack `private-eve-dev-skills/` (kept local), `git rm magic-link-fail.png`; **`.beads` removal deferred to flip** (active tracker)
- [x] Genericize hosted-instance hostname `example.example.dev` → `eve.example.com` (64 files); strip user home-dir paths
- [~] Sanitize `CLAUDE.md`, `AGENTS.md` — **values scrubbed**; deeper internal-process content review still open (see judgment calls)
- [x] Root MIT `LICENSE` (`Adam Chesney and Incept5`) + `THIRD_PARTY.md`
- [x] `packages/{auth,auth-react,chat,chat-react,cli}/LICENSE` (MIT)
- [x] `"license":"MIT"` on all `@eve/*` packages + root
- [x] `private:true` added to apps/api + apps/orchestrator (`@eve/migrate` left publishable)
- [x] Fix README license section; add public Docker-Compose quickstart + "Deploying to Your Own Cloud" (3-repo model)
- [x] `.env.test` fixture comment + `.gitleaks.toml` allowlist
- [x] `CONTRIBUTING`/`CODE_OF_CONDUCT`/`SECURITY`/`TRADEMARKS`; `.github` issue/PR templates
- [ ] **Open:** CI license gate; deeper CLAUDE.md/AGENTS.md review; `../deployment-instance` doc refs; assorted test email domains (`example.eve.dev`/`.io`/`.test`)
- [ ] **Gated (flip):** `git rm -r .beads/`; `gitleaks`/`trufflehog` full-history pass; flip public + branch protection
- **Verified:** `@eve/api` unit tests (306) pass, scenario recipient lint passes, orchestrator typechecks; shippable-tree sweep shows 0 account-id / personal-email / Slack-token / private org-id hits (excl. `.beads`)

### eve-horizon-infra (eve-horizon, ALREADY public — urgent) — ✅ DONE on branch (commit `0095a8f`, unpushed)
- [x] Add MIT `LICENSE` (public today with NO license = all-rights-reserved)
- [x] Genericize default `aws` overlay: EIPs, IRSA ARN/account-id, `eve.example.com` hosts/buckets → placeholders (mirror `aws-eks`)
- [x] De-hardcode TF S3 backend → partial config at `init` (+ `backend.hcl.example`, gitignore)
- [x] Genericize account-id/ARNs in `docs/plans/*`, `ses-feedback.tf`, `variables.tf:400`
- [x] Fix README license section; add `SECURITY.md`
- [x] **Push** (pushed to `eve-horizon-infra` main: `0095a8f`)
- [ ] Scanner pass (already public — do promptly)
- [x] *(was separate, now done)* Fix pre-existing `kustomize build` breakage — ported 3 generic base files + dashboard listing, realigned `aws` overlay, fixed `gcp` duplicate-SA. All 3 overlays build (`eve-horizon-infra@8604fe5`, closed `eve-horizon-52lkp`).

### eve-horizon-starter (the platform operator, private → public; canonical starter)
- [ ] Fix README:369 "MIT" text → add real MIT `LICENSE`; `license` field in `apps/api/package.json`
- [ ] Light governance files; flip public
- [ ] Become the single canonical starter (absorb `eve-quickstart`)
- [ ] (Optional) move/rename under neutral `eve-horizon` org; update `eve init` default
      (`packages/cli/src/commands/init.ts:12`) per `self-hosted-production-execution-plan.md:132`

### eve-quickstart (eve-horizon, public → archive) — ✅ licensed/scrubbed (`2ed5cba`); archive deferred
- [x] MIT `LICENSE` + genericize internal values (account id, example hosts, org/proj ids)
- [ ] Replace README with a redirect to the canonical starter — **deferred** (it's the *only* public starter until `eve-horizon-starter` flips public)
- [ ] Archive the repo (read-only) — **deferred** until consolidation

### eve-horizon-fullstack-example (the platform operator, private → public)
- [ ] MIT `LICENSE`; `license` fields in app `package.json`s; keep demo `dev-secrets.yaml`
- [ ] Light governance; scanner pass; flip public

### eve-horizon-showcase (the platform operator, private → public)
- [ ] Confirm `env.secrets` stays gitignored; MIT `LICENSE`; `license` fields
- [ ] Light governance; scanner pass; flip public

### AgentPack examples
- [x] **ingest-agentpack** — MIT `LICENSE` added in place (`0e7b493`); clean, scanner pass
- [x] **learning-loop-agentpack** — MIT `LICENSE` + genericized example host (`73d6dd2`)
- [ ] **eve-software-factory** (still private) — MIT `LICENSE` + README framing; flip public

### eve-skillpacks (the platform operator, private → public)
- [ ] Remove AWS account ID + EKS ARN from `references/overview.md` (~lines 64–69)
- [ ] Blank `.eve/profile.yaml`; rotate untracked `secrets.env` PAT (hygiene)
- [ ] MIT `LICENSE`; governance files; scanner pass; flip public

### eve-horizon-docs (eve-horizon, already public + MIT) — ✅ DONE (`09c0651`)
- [x] Reconcile LICENSE copyright line to `Adam Chesney and Incept5`
- [x] Genericize `eve.example.com` → `eve.example.com`, `org_example` → `org_example`, scrub account id/cluster from vendored operator note
- [x] Scanner pass (no flip needed)

---

## 11. Git-history scrub — NOT REQUIRED (verified 2026-06-23)

**A history rewrite is not needed.** The Slack token that originally appeared to require a
scrub was only ever a truncated, non-exploitable prefix (§5.1) — a full-history blob scan
confirmed the real token is in **zero commits**. All other `ghp_`/`xoxb-`/`sk-ant` history
hits are dummy test fixtures, and the real secret files (`manual-tests.secrets`,
`system-secrets.env.local`, `secrets.env`) were **never committed** (0 history hits).
`eve-horizon-infra` history is likewise clean (no state/kubeconfigs ever committed).

So `eve-horizon` can publish **with full history intact** — just redact the working-tree
prefix (§5.1) before flipping. Keep this runbook on hand only as a contingency if the
pre-flip scanner (§5.8) surfaces something genuinely sensitive:

```bash
# Contingency only — if gitleaks/trufflehog flags a REAL secret in history:
git clone --mirror git@github.com:eve-horizon/eve-horizon.git eve-horizon-scrub.git
cd eve-horizon-scrub.git
printf '<real-secret>==>REDACTED\n' > /tmp/replacements.txt
git filter-repo --replace-text /tmp/replacements.txt
gitleaks detect --source . --redact -v && trufflehog git file://. --only-verified
git push --force --mirror git@github.com:eve-horizon/eve-horizon.git   # rewrites SHAs — re-clone all copies
```

> **Optional, unrelated to secrets:** if you want a leaner clone, `git filter-repo
> --invert-paths --path docs/system/openapi.json --path .beads/issues.jsonl` drops
> generated-artifact churn (~tens of MB). Purely cosmetic; `.git` is already a healthy 76 MB.

---

## 12. Risks & open questions

| Risk / question | Mitigation / owner |
| --- | --- |
| **6 repos already public, several unlicensed** | "All rights reserved" by default today. Adding MIT is the urgent fix; the infra template's instance-config leak (§5.2) is live now — prioritize. |
| ~~Slack token in history~~ | **Resolved** — only a non-exploitable 15-char prefix was committed; full token never in history (§5.1). No rotation/scrub. |
| **Two GitHub orgs** (`the platform operator` + `eve-horizon`) | Optional post-launch: consolidate all OSS repos under the neutral `eve-horizon` org for a coherent public presence; transfer the private→public ones on flip. Not blocking. |
| **`eden` is public + unlicensed** | Per decision, handled separately — but it needs its own licensing/product call (commercial vs OSS). Flag to owner; don't leave it indefinitely all-rights-reserved-while-public. |
| `eve-pm` strategy | Deferred; revisit as flagship example vs commercial product. |
| `cc-mirror` license unverified | Confirm on npm before relying on it in published images; affects images only, not source. |
| Trademark / npm-scope ownership | `TRADEMARKS.md`; confirm `@eve-horizon` scope; register/document the "Eve Horizon" mark. |
| Future copyleft dep sneaks in | CI license gate (`license-checker --failOn 'GPL;AGPL;LGPL;SSPL;BUSL'`). |

---

## 13. Definition of done

- [ ] All in-scope repos public under **MIT**, `Copyright (c) 2026 Adam Chesney and Incept5`,
      with a root `LICENSE` (and per-package for the 5 npm packages).
- [ ] `gitleaks` **and** `trufflehog` pass on the **full history** of every published repo.
- [ ] Slack-token prefix + integration IDs redacted in the working tree (no rotation/scrub
      needed — full token was never committed, §5.1); no real secret in any tree/history.
- [ ] `eve-horizon-infra` default `aws` overlay + TF backend genericized (no the platform operator EIPs,
      account id, hosts, buckets); template usable by an outsider unchanged.
- [ ] A clean-machine `git clone … && pnpm install && ./bin/eh start docker` reaches the API
      at `http://localhost:4801`; the public infra template deploys to a fresh cloud account
      with **no** access to the platform operator private infra.
- [ ] Every `package.json` has `"license": "MIT"`; `private:true` audit done.
- [ ] `CONTRIBUTING`/`CODE_OF_CONDUCT`/`SECURITY`/`TRADEMARKS`/`THIRD_PARTY` present where applicable.
- [ ] Starters consolidated (`eve-quickstart` archived → redirects to canonical starter).
- [ ] Branch protection on `main`; issue/PR templates live; CI license gate green.
- [ ] No `deployment-instance-repo`, predecessor (`eve`/`eve-source`), `eve-pm`, `eden`, or
      `eve-horizon-dashboard` content leaked into the published set.

---

## Appendix A — MIT license & header

**`LICENSE` (root of every published repo):**
```
MIT License

Copyright (c) 2026 Adam Chesney and Incept5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Optional per-file header (deferred; SPDX one-liner):**
```
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Adam Chesney and Incept5
```
Apply with `addlicense -c "Adam Chesney and Incept5" -l mit -y 2026 apps packages tools scripts`
(first-party dirs only) if headers are ever wanted.

## Appendix B — audit provenance

Derived from a multi-track audit (2026-06-18, extended 2026-06-23):
1. `eve-horizon` core (secrets in tree + history, internal coupling, hygiene).
2. Satellite repos (skillpacks, starter, fullstack-example).
3. Ambiguous/legacy classification (eve, eve-source, eve-pm, dashboard, showcase, software-factory).
4. Dependency-license compatibility + release hygiene.
5. `eve-horizon-infra` template review + discovery of the already-public `eve-horizon` org
   (eve-horizon-docs, eve-quickstart, ingest-agentpack, learning-loop-agentpack, eden).

Key empirical findings: `eve-horizon` `.git` is 76 MB (healthy); its 1.8 GB working tree is
entirely gitignored/untracked; real secret files were **never** committed (0 history hits);
dependency tree is 100% permissive (zero copyleft); `eve-horizon-infra` history is clean
(no state/kubeconfigs ever committed) but its default overlay ships live instance config;
6 ecosystem repos are already public, most without a license.

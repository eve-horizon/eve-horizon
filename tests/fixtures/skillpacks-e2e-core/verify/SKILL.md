---
name: e2e-core__verify
description: Verify skill pack resolution and emit a deterministic marker.
---

# E2E Skill Pack Verification

Goal: confirm the expected skill packs are mounted in `.skills/` and emit a
deterministic marker so the e2e test can validate real harness output.

Steps:
1. Run a shell command to list `.skills/` and confirm it contains `e2e-core`
   and `e2e-repo`.
2. If both are present, output **exactly** this line in your response:

```
skill-pack-check core_pack=e2e-core repo_pack=e2e-repo
```

3. If either pack is missing, output:

```
skill-pack-missing core_pack=e2e-core repo_pack=e2e-repo
```

Keep your response to just the single marker line.

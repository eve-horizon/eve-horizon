# 49 - Cross-Project App Links: CLI

1. Complete scenario 48 with a producer API export that includes `cli: obs`.
2. Ensure the producer service declares `x-eve.cli.image`.
3. Dispatch a consumer job with `--with-links observation`, or rely on `inject_into.jobs: true`.
4. In k8s runtime, verify the runner pod includes an app CLI init container.
5. Inside the job environment, verify:
   - `EVE_APP_CLI_PATHS` includes `/opt/eve/app-cli/obs/bin`
   - `EVE_APP_LINK_OBSERVATION_CLI=obs`
   - `obs --help` runs.
6. Verify the job description includes cross-project app-link instructions.

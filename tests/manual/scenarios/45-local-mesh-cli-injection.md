# 45 - Local App-Link Mesh: CLI Injection

1. Start and deploy the local k3d platform.
2. Set `EVE_API_URL=http://api.eve.lvh.me` and log in to the local profile.
3. Ensure the test org: `eve org ensure manual-test-org --json`.
4. Create a workspace:
   `eve local mesh init lmesh-cli --org org_manualtestorg --env local --force`.
5. Add fixtures:
   `eve local mesh add pcli --path tests/manual/fixtures/local-mesh/producer-cli`
   and
   `eve local mesh add ccli --path tests/manual/fixtures/local-mesh/consumer-cli`.
6. Run `eve local mesh up`. Verify it builds and imports an image like
   `local/pcli-cli:<sha>` before syncing `pcli`.
7. Run `eve app-links list --project <pcli-project-id> --json` and verify the
   producer grant records the local CLI image, not the fixture's `ghcr.io/...`
   image.
8. Dispatch a linked job:
   `eve job create --project <ccli-project-id> --env local --with-links observation --description "Run obs --help and obs observations list --json"`.
9. Follow the job. Verify the runner can resolve `obs`, `obs --help` exits 0,
   and `obs observations list --json` returns the producer fixture data.
10. Change the producer CLI script output, rerun `eve local mesh redeploy pcli`,
    and verify the next linked job mounts the new `local/pcli-cli:<sha>` image.

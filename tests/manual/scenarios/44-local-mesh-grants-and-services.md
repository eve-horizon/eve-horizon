# 44 - Local App-Link Mesh: Grants and Services

1. Start and deploy the local k3d platform:
   `./bin/eh k8s start && ./bin/eh k8s deploy`
2. Set `EVE_API_URL=http://api.eve.lvh.me` and log in to the local profile.
3. Ensure the test org: `eve org ensure manual-test-org --json`.
4. Create a workspace:
   `eve local mesh init lmesh --org org_manualtestorg --env local --force`.
5. Add fixtures:
   `eve local mesh add prod --path tests/manual/fixtures/local-mesh/producer`
   and
   `eve local mesh add cons --path tests/manual/fixtures/local-mesh/consumer`.
6. Run `eve local mesh up`. Verify stdout syncs/deploys `prod` before `cons`.
7. Run `eve local mesh status`. Verify both rows are ready and `cons` lists the
   `observation` subscription.
8. In the consumer namespace, verify injected env:
   `./bin/eh kubectl -n eve-manualtestor-cons-local exec deploy/local-api -- printenv | rg EVE_APP_LINK_OBSERVATION_`.
9. From the consumer pod, call the producer:
   `./bin/eh kubectl -n eve-manualtestor-cons-local exec deploy/local-api -- sh -lc 'curl -fsS -H "Authorization: Bearer $EVE_APP_LINK_OBSERVATION_TOKEN" "$EVE_APP_LINK_OBSERVATION_API_URL/observations"'`.
10. Remove `cons` from the producer allowlist, rerun
    `eve local mesh redeploy cons`, and verify the consumer sync fails with the
    app-link grant/scope error.
11. Restore the fixture and run `eve local mesh down`. Verify tenant namespaces
    are gone and the `eve` platform namespace remains.

# 46 - Local App-Link Mesh: Diagnose Probe

1. Complete scenario 44 through `eve local mesh up`.
2. Run `eve local mesh diagnose --workspace lmesh`. Verify `cons` reports
   `observation` as `OK` and does not print any raw token values.
3. Run `eve local mesh diagnose --workspace lmesh --probe`. Verify the probe job
   reaches `$EVE_APP_LINK_OBSERVATION_API_URL/health` from the consumer
   namespace and reports `OK/ok`.
4. Break the link by changing the consumer alias to request a missing scope or
   by undeploying `prod`.
5. Rerun `eve local mesh diagnose --probe`. Verify the output reports the
   failing alias, includes the status/body excerpt, and still redacts token
   values.
6. Run `eve local mesh down --workspace lmesh` to clean up tenant namespaces.

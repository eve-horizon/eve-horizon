# 47 - Cross-Project App Links: Grants

1. Start local k3d and deploy the platform.
2. Create two projects in the same org: `producer` and `consumer`.
3. Sync a producer manifest with `x-eve.app_links.exports.apis.observation`.
4. Run `eve app-links list --project <producer>` and verify the consumer grant is listed.
5. Sync a consumer manifest with `x-eve.app_links.consumes.observation`.
6. Run `eve app-links list --project <consumer>` and verify the subscription is listed.
7. Change the consumer requested scope to one not granted by the producer.
8. Re-run `eve project sync --project <consumer>` and verify sync fails with the missing-scope message.
9. Remove the consumer from the producer export and re-sync producer.
10. Run `eve app-links explain --consumer <consumer> --alias observation` and verify the grant is reported revoked or missing.

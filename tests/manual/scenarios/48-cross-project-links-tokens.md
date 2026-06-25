# 48 - Cross-Project App Links: Tokens

1. Complete scenario 47 with an active API subscription.
2. Deploy the producer `staging` environment.
3. Deploy the consumer `staging` environment with `inject_into.services: [api]`.
4. Inspect the consumer pod env and verify `EVE_APP_LINK_OBSERVATION_API_URL` and `EVE_APP_LINK_OBSERVATION_TOKEN` are present.
5. Decode the token payload and verify:
   - `type` is `app_link`
   - `aud` is `project:<producer_project_id>`
   - `producer_env` is `staging`
   - `scopes` match the consumer subscription.
6. Call `/auth/token/verify` with the app-link token and verify the response type is `app_link`.
7. Revoke the producer grant and verify the same token is rejected by verification.

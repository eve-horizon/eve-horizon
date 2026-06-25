# 35 - Embedded Conversation WebChat JWT

Validates that WebChat accepts only cryptographically verified Eve RS256 tokens.

## Steps

1. Check ownership and deploy local k3d:
   ```bash
   ./bin/eh status
   ./bin/eh k8s deploy
   export EVE_API_URL=http://api.eve.lvh.me
   ```
2. Mint a real token:
   ```bash
   eve profile use local
   TOKEN=$(eve auth token --raw)
   ```
3. Connect to WebChat:
   ```bash
   npx wscat -c "ws://gateway.eve.lvh.me/?token=$TOKEN"
   ```
   Expect `{"type":"connected"}`.
4. Mutate the signature byte and reconnect. Expect close code `4001` and reason `token_invalid`.
5. Create an HS256 token with the same payload. Expect close code `4001` and reason `token_invalid`.
6. Reconnect with an expired Eve token. Expect close code `4001` and reason `token_expired`.
7. Check gateway logs:
   ```bash
   kubectl -n eve logs deploy/eve-gateway --tail 100 | rg webchat.token_invalid
   ```
   Expect invalid signature / expiry events, never decode-only acceptance.

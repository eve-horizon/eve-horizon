# Cross-Project App Links

> Status: Current
> Last Updated: 2026-05-15

App links let one project consume another project's API, CLI, and app events without shared long-lived secrets.

## Manifest Shape

Producer projects declare exports at `x-eve.app_links.exports`.

```yaml
x-eve:
  app_links:
    exports:
      apis:
        observation:
          service: api
          cli: obs
          scopes: [observations:read, deployments:read]
          consumers:
            - project: consumer
              scopes: [observations:read]
              envs: [staging]
      events:
        observation-feed:
          types: [app.observation.created]
          consumers:
            - project: consumer
```

Consumer projects declare subscriptions at `x-eve.app_links.consumes`.

```yaml
x-eve:
  app_links:
    consumes:
      observation:
        project: producer
        api: observation
        environment: same
        scopes: [observations:read]
        events:
          feed: observation-feed
          types: [app.observation.created]
        inject_into:
          services: [api]
          jobs: true
```

## Runtime Contract

Injected service and job surfaces receive:

- `EVE_APP_LINK_<ALIAS>_API_URL`
- `EVE_APP_LINK_<ALIAS>_TOKEN`
- `EVE_APP_LINK_<ALIAS>_SCOPES`
- `EVE_APP_LINK_<ALIAS>_PROJECT`
- `EVE_APP_LINK_<ALIAS>_ENV`
- `EVE_APP_LINK_<ALIAS>_CLI` when the producer exported an image-mode CLI

Tokens are Eve-signed RS256 JWTs with `type: "app_link"` and `aud: "project:<producer_project_id>"`. Verification re-reads the active grant/subscription so producer revocation is effective without waiting for token expiry.

## Events

Producer events fan out through `app_link_event_deliveries`. Consumer events are inserted with `source: app_link`, the original event type, and a dedupe key of `app_link:<subscription_id>:<source_event_id>`.

Consumers can trigger workflows with:

```yaml
trigger:
  app_link:
    alias: observation
    type: app.observation.created
```

## Diagnostics

Use:

```bash
eve app-links list --project <project>
eve app-links plan --project <consumer> --file .eve/manifest.yaml
eve app-links explain --consumer <consumer> --alias observation
```

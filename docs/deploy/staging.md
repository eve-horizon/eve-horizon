# Hosted Deployment Instances

> Status: Current
> Last Updated: 2026-06-25

Eve Horizon supports hosted deployment instances, but this public source repo
does not own any specific staging or production cluster.

Instance-specific Kubernetes overlays, Terraform variables, kubeconfigs,
secrets, domains, release procedures, cost evidence, and incident runbooks
belong in the private deployment instance repository that operates that
environment.

## Deployment Flow

Hosted deployments use the same source-to-instance pattern:

1. This source repo builds and publishes versioned service images.
2. The deployment instance repo selects a source version.
3. The deployment instance repo applies its own Terraform, manifests, secrets,
   and rollout policy.
4. Health checks and rollback decisions happen in the deployment instance repo.

This separation keeps the open-source platform portable while preserving each
operator's private infrastructure state.

## Public Guidance

- Use [AWS Deployment](./aws.md) for the public template-based AWS path.
- Use [Deployment Architecture](../system/deployment.md) for runtime concepts.
- Keep private cluster names, account IDs, kubeconfig paths, domains, and
  operational evidence out of this repository.

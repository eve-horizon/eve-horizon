# AWS Deployment

> Status: Current
> Last Updated: 2026-02-11

## Infrastructure Extracted

AWS deployment infrastructure has been extracted from this repository into a
template repo that can be instantiated per environment:

**`eve-horizon/eve-horizon-infra`** (public template)

## Deployment Flow

1. **Create a new repo** from the `eve-horizon/eve-horizon-infra` template
2. **Configure** — fill in your AWS region, domain, database endpoint, and secrets
3. **Terraform** — provision the VPS, RDS, DNS, and security groups
4. **Deploy** — apply the Kustomize overlay to your k3s cluster

The template includes:
- `terraform/aws/` — full Terraform configuration for a single-node k3s + RDS setup
- `k8s/overlays/aws/` — Kustomize overlay with placeholders for your domain and DB
- `deploy.yml` — GitHub Actions workflow for automated deployments
- Operational CLI and documentation

## Prerequisites

- Ubuntu 22.04+ VPS on AWS (single node)
- A public domain with DNS control
- External Postgres (RDS or managed Postgres)
- Container registry credentials (public ECR by default, or private ECR mirror)

## Images

This repo publishes container images to `public.ecr.aws/w7c4v0w3/eve-horizon` via
`publish-images.yml` workflow. It can also publish to private ECR when
`ECR_REGISTRY` plus `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are configured
in GitHub Actions.
For anonymous/public pulls, use ECR Public (`public.ecr.aws/<alias>`). Private
ECR endpoints (`<account>.dkr.ecr.<region>.amazonaws.com`) require auth.
The infra template uses the `platform.registry` value in `config/platform.yaml`
to select the registry namespace.
See [Container Registry](../system/container-registry.md) for details on image
tags and authentication.

## Detailed Instructions

For the full provisioning checklist, secrets setup, DNS configuration, and
troubleshooting, see the **README.md** and **DEPLOYMENT.md** in your
instantiated infra repository.

## Related Documentation

- [Hosted Deployment Instances](./staging.md) - How source releases relate to private instance repos
- [Container Registry](../system/container-registry.md) - Image publishing and registry setup
- [Deployment Architecture](../system/deployment.md) - Runtime modes and K8s architecture

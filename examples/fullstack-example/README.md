# Fullstack Example

This is a sample project demonstrating Eve Horizon manifest configuration.

## Purpose

This example shows how to configure a fullstack application with:
- Multiple environments (staging, production, test)
- Component definitions for K8s deployment
- Default environment and harness settings

## Manifest Configuration

The `.eve/manifest.yaml` file demonstrates:

1. **Project Identification**: Defines the project name used for job scheduling
2. **Default Settings**: Specifies default environment and harness for jobs
3. **Environment Definitions**:
   - `staging`: Persistent environment for testing
   - `production`: Persistent environment for live deployments
   - `test`: Temporary environment with auto-generated namespace
4. **Component Definitions**: Defines services for future K8s deployment
   - `api`: Backend service
   - `web`: Frontend service

## Access Policy Configuration

The example also includes `.eve/access.yaml` (version 2) that demonstrates
group-scoped data-plane access for:

1. org documents (`orgdocs:*`)
2. org filesystem (`orgfs:*`)
3. environment database visibility (`envdb:*`)

Use this file with:

```bash
eve access validate --file .eve/access.yaml
eve access plan --file .eve/access.yaml --org org_xxx
eve access sync --file .eve/access.yaml --org org_xxx --yes
```

## Usage

When creating jobs for this project, Eve Horizon will use the manifest to:
- Select the default environment (staging) unless `--env` is specified
- Use the docker harness by default
- Reference component definitions for K8s deployment

## Example Commands

```bash
# Create a job using default environment (staging)
eve job create --project proj_xxx --description "Deploy API changes"

# Create a job with specific environment
eve job create --project proj_xxx --env production --description "Production deployment"

# Create a temporary test job
eve job create --project proj_xxx --env test --description "Run integration tests"
```

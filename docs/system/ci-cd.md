# CI/CD

This document covers the GitHub Actions workflows for continuous integration and CLI publishing.

## Workflows

### CI (`ci.yml`)

Runs on every push and pull request to `main`.

**Steps:**
1. Checkout code
2. Setup pnpm and Node.js 22
3. Install dependencies
4. Build all packages
5. Run unit tests

### Publish CLI (`publish-cli.yml`)

Runs when a tag matching `cli-v*` is pushed.

**Steps:**
1. Checkout code
2. Setup pnpm and Node.js 22
3. Install and build
4. Extract version from tag
5. Publish `@eve-horizon/cli` to npm

## Setup

### 1. npm Access Token

1. Go to https://www.npmjs.com → **Access Tokens** → **Generate New Token**
2. Select **Granular Access Token**
3. Set permissions: **Read and write** for packages
4. Copy the token

### 2. GitHub Secret

1. Go to repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `NPM_TOKEN`
4. Value: paste your npm token

### 3. npm Organization

The CLI publishes as `@eve-horizon/cli`. Ensure the `eve-horizon` organization exists on npm, or update the package name in `packages/cli/package.json`.

## Publishing a Release

```bash
# Create and push a version tag
git tag cli-v0.1.0
git push origin cli-v0.1.0
```

The workflow will:
- Build the CLI
- Set the version from the tag
- Publish to npm with provenance

## Installing the CLI

Once published:

```bash
npm install -g @eve-horizon/cli
```

Or with a specific version:

```bash
npm install -g @eve-horizon/cli@0.1.0
```

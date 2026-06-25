# PR Preview Environments

> Status: Current
> Last Updated: 2026-01-29

## Overview

PR preview environments allow reviewers to test changes on a real deployment. When a pull request is opened or updated, Eve automatically:

1. Creates a dedicated preview environment (e.g., `pr-123`)
2. Builds and deploys the changes to that environment
3. Provides a stable URL for reviewers to access the deployed application
4. Cleans up the environment when the PR is closed

## Sharing Preview Access with Reviewers

When you want to share access to a PR preview environment with reviewers, use the `eve auth token` command to generate a short-lived access token.

### Step 1: Get a Short-Lived Access Token

```bash
eve auth token
```

This outputs your current authentication token to stdout. The token is valid for the duration of your login session (typically 24 hours).

**Example output:**
```
eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0.eyJzdWIiOiJ1c2VyX2FiYzEyMyIsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSIsInR5cGUiOiJ1c2VyIiwiaWF0IjoxNzA2MDAwMDAwLCJleHAiOjE3MDYwODY0MDB9.signature...
```

### Step 2: Share with Reviewers

Share both the preview URL and the token with reviewers. For example:

```
Preview URL: https://web.my-project-pr-123.example.com
Auth Token: eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0...

To access the preview, use the token in your HTTP request:

  curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0..." \
       https://web.my-project-pr-123.example.com
```

Or for browser access:

```
1. Visit: https://web.my-project-pr-123.example.com
2. When prompted for authentication, paste the token above
```

### Step 3: Reviewer Access

Reviewers can then use the token to authenticate with the preview environment. The specific method depends on the application:

#### Browser Access

If the application is a web app with a UI:

```bash
# Copy the token
TOKEN=$(eve auth token)

# Open in browser and authenticate (token may need to be pasted into login form)
open "https://web.my-project-pr-123.example.com"
```

#### API Access

For API testing:

```bash
# Get the token
TOKEN=$(eve auth token)

# Call the API with the token
curl -H "Authorization: Bearer $TOKEN" \
     https://web.my-project-pr-123.example.com/api/endpoint
```

## Token Security & Expiration

### Validity Period

- **Duration**: Tokens are valid for 24 hours by default (configured server-side)
- **Scope**: Personal tokens have the same permissions as your user account
- **Single Use**: The same token can be used multiple times until it expires

### Revoking Access

To revoke access before expiration:

1. **Revoke your token**: Log out of the CLI or delete your credentials
   ```bash
   eve auth logout
   ```
   This invalidates all tokens issued to your profile.

2. **Extend expiration**: Set a shorter expiration time in your profile settings (if available)

3. **Close the PR**: Deleting the PR preview environment also invalidates the environment-specific access

### Best Practices

- **Share tokens carefully**: Treat tokens like passwords
- **Limit lifetime**: Only share tokens when necessary
- **Use dedicated accounts**: Consider using a separate Eve account for sharing preview access
- **Update documentation**: Keep reviewers informed about token expiry dates
- **Rotate regularly**: Ask reviewers to request fresh tokens after 24 hours

## Viewer Workflow for Reviewers

As a reviewer receiving preview access:

### Prerequisites

- Eve CLI installed (or tokens can be used directly in HTTP requests)
- Access to the preview URL provided by the developer

### Accessing the Preview

**Option 1: Using the CLI (if you have an Eve account)**

```bash
# If you have your own Eve credentials, you can also generate your own token
eve auth token
```

**Option 2: Using a shared token via curl**

```bash
# Set the token provided to you
TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0..."

# Call the API
curl -H "Authorization: Bearer $TOKEN" \
     https://web.my-project-pr-123.example.com/api/test

# Or save to environment variable for repeated use
export EVE_TOKEN="$TOKEN"
curl -H "Authorization: Bearer $EVE_TOKEN" \
     https://web.my-project-pr-123.example.com/api/endpoint1
curl -H "Authorization: Bearer $EVE_TOKEN" \
     https://web.my-project-pr-123.example.com/api/endpoint2
```

**Option 3: Browser access with token**

For web applications, the token should be submitted when prompted:

1. Visit the preview URL: `https://web.my-project-pr-123.example.com`
2. If prompted for authentication, paste the token as your "password" or API token
3. The browser may store the token (handle as per application security policy)

## Finding Your Preview URL

Preview URLs are available in multiple locations:

### 1. Pipeline Run Output

After the PR deploy pipeline completes, check the pipeline run output:

```bash
eve pipeline show-run deploy-pr prun_xxx
```

Look for `preview_url` in the output.

### 2. PR Review Summary

When the epic job enters final review, the job result includes the preview URL:

```bash
eve job result MyProj-abc123
```

Look for `preview_url` in the job result JSON.

### 3. Manual Environment Lookup

List environments for the project to find preview environments:

```bash
eve env list --project proj_xxx

# Output:
# Environment: pr-123 (persistent)
#   Ingress: web.my-project-pr-123.example.com
#   Status: ready
#   Labels:
#     pr_number: 123
#     pr_branch: feat/dashboard
#     pr_sha: abc123def456
#     pr_url: https://github.com/org/repo/pull/123
```

## Preview Environment Naming

Preview environments follow a consistent naming pattern:

- **Format**: `pr-<number>`
- **Example**: `pr-123` for PR #123
- **Ingress URL**: `{service}.{project}-{env}.{domain}`
  - Example: `web.my-project-pr-123.example.com`

## Cleanup

Preview environments are automatically cleaned up when:

1. **PR is closed**: The cleanup pipeline runs and deletes the environment
2. **Manual deletion**: An admin can manually delete with:
   ```bash
   eve env delete pr-123
   ```

Note: Deleting an environment invalidates all tokens for that environment's resources.

## CLI Token Command Reference

### eve auth token

Prints your current access token to stdout for use in scripts and HTTP requests.

**Usage:**
```bash
eve auth token [--print]
```

**Options:**
- `--print`: Explicitly request token print (default behavior)

**Examples:**

```bash
# Print the token
eve auth token

# Copy to clipboard (macOS)
eve auth token | pbcopy

# Store in variable
TOKEN=$(eve auth token)

# Use in API request
curl -H "Authorization: Bearer $(eve auth token)" https://api.example.com

# Export for multiple requests
export EVE_TOKEN=$(eve auth token)
curl -H "Authorization: Bearer $EVE_TOKEN" https://api.example.com/endpoint1
curl -H "Authorization: Bearer $EVE_TOKEN" https://api.example.com/endpoint2
```

**Requirements:**
- Must be logged in (run `eve auth login` if needed)
- Token will be a valid JWT valid for the user's session

## Troubleshooting

### "No valid token found. Please login first"

You need to authenticate before you can get a token:

```bash
eve auth login --email your@email.com
# Then try again:
eve auth token
```

### Token expired or invalid

If a reviewer reports authentication errors:

1. **Generate a fresh token**:
   ```bash
   eve auth token
   ```

2. **Share the new token** with the reviewer

3. **Verify the preview environment still exists**:
   ```bash
   eve env list --project proj_xxx
   ```

### Preview URL not working

If the preview URL is inaccessible:

1. **Verify the environment exists**:
   ```bash
   eve env show proj_xxx pr-123
   ```

2. **Check deployment status**:
   ```bash
   eve pipeline show-run deploy-pr prun_xxx
   ```

3. **Check for errors in the deploy logs**:
   ```bash
   eve job logs MyProj-abc123
   ```

### "Authorization denied"

The token may not have appropriate permissions for the requested resource. Ensure:

1. The token is from the original developer or someone with appropriate permissions
2. The token hasn't expired (24 hour default window)
3. The resource (preview environment) still exists

## Related Topics

- [Authentication & Governance](./auth.md) - Detailed auth configuration and token types
- [Environments](./system-overview.md#environments) - Environment management basics
- [Pipelines](./pipelines.md) - PR preview pipeline configuration

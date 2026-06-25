# Cloud File System Integration Plan

> **Status**: Draft
> **Author**: AI Architect
> **Date**: 2026-03-14
> **Target**: Google Drive (initial), Box / OneDrive (future)

---

## 1. Vision

An Eve org connects its Google Drive once. From that point forward, agents can read, write, organize, and index files in that Drive as naturally as they use org docs today. Files uploaded via Slack land in the right project folder. Agents ask humans clarifying questions before filing. The org's knowledge base stays current automatically.

**The filing agent becomes the organization's digital librarian** — it receives documents from any channel (Slack, API, CLI), understands the content, asks for clarification when needed, files to the correct location in the org's cloud drive, and updates a searchable index.

---

## 2. Design Philosophy

### Compose, Don't Duplicate

Every piece of this integration maps onto existing Eve primitives:

| Existing Primitive | Cloud FS Role |
|---|---|
| **Integrations** (OAuth + tokens) | Google Drive connection per org |
| **Ingest** (upload → event → agent) | Files from Slack/API enter the same pipeline |
| **Org Documents** (versioned, searchable) | Index/metadata layer for filed documents |
| **Org FS Sync** (event spine, path model) | Cloud FS mounts as a "remote" in the sync topology |
| **Chat Gateway** (Slack → agent routing) | Slack file uploads trigger the filing workflow |
| **Workflows** (event → agent steps) | `doc.ingest` event drives the filing agent |
| **Threads** (HITL conversation) | Agent asks clarifying questions in the Slack thread |
| **RBAC** (scoped permissions) | Cloud FS operations respect Eve access groups |

### Provider Pattern

Google Drive is the first provider. The interface is designed so Box, OneDrive, and Dropbox slot in without changing agents or workflows. Agents work with **Eve resource URIs**, not provider-specific APIs.

### Agent-Native

Cloud file operations are exposed as **tools** the agent can call during execution — not as batch sync jobs. The agent decides what to do with a file based on its content, the user's instructions, and the org's folder structure. This is fundamentally different from dumb sync — it's intelligent filing.

---

## 3. Architecture

```
                                     ┌──────────────────────┐
                                     │   Google Drive API    │
                                     │  (OAuth2 per org)     │
                                     └──────────┬───────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          │                     │                     │
                   ┌──────▼──────┐    ┌────────▼────────┐   ┌───────▼───────┐
                   │  Cloud FS   │    │   Watch/Poll    │   │    Webhook    │
                   │  Provider   │    │   Service       │   │    Receiver   │
                   │  (API ops)  │    │   (changes)     │   │    (push)     │
                   └──────┬──────┘    └────────┬────────┘   └───────┬───────┘
                          │                    │                     │
                          │                    └─────────┬───────────┘
                          │                              │
                 ┌────────▼────────────┐    ┌───────────▼───────────┐
                 │   Cloud FS Module   │    │   Change → Event      │
                 │   (NestJS service)  │    │   Emitter             │
                 │                     │    │   (→ system.cloud_fs.  │
                 │   • mount CRUD      │    │      file.created/    │
                 │   • token refresh   │    │      modified/deleted)│
                 │   • op dispatch     │    │                       │
                 └────────┬────────────┘    └───────────────────────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
     ┌────────▼──┐  ┌─────▼─────┐  ┌──▼──────────┐
     │  Mount    │  │  Agent    │  │  Index       │
     │  Registry │  │  Tools    │  │  Service     │
     │  (DB)     │  │  (harness │  │  (org docs   │
     │           │  │   access) │  │   update)    │
     └───────────┘  └───────────┘  └─────────────┘
```

### Core Components

1. **Cloud FS Provider** — Abstraction over Google Drive / Box / OneDrive APIs
2. **Cloud FS Module** — NestJS service managing mounts, tokens, and operations
3. **Mount Registry** — DB table mapping `(org, project?) → provider folder`
4. **Agent Tools** — File operations exposed to agents via the tool-home pattern
5. **Change Watcher** — Hybrid push/poll for detecting external changes
6. **Index Service** — Updates org docs when files are filed
7. **Policy Gate** — Explicit policy checks for scope, RBAC, and idempotency before write actions

---

## 4. Data Model

### 4.1 Cloud FS Mounts

A **mount** maps an Eve scope (org or project) to a folder in a cloud file system. This is the central routing table.

```sql
-- Migration: 00XXX_cloud_fs_mounts.sql

CREATE TABLE cloud_fs_mounts (
  id              TEXT PRIMARY KEY,           -- cfm_xxx (TypeID)
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE, -- NULL = org-level mount
  integration_id  TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,

  -- Provider details
  provider        TEXT NOT NULL,              -- 'google_drive', 'box', 'onedrive'
  root_folder_id  TEXT NOT NULL,              -- Provider's folder ID
  root_folder_path TEXT,                      -- Human-readable path (for display)

  -- Behavior
  mode            TEXT NOT NULL DEFAULT 'read_write'
                  CHECK (mode IN ('read_only', 'write_only', 'read_write')),
  auto_index      BOOLEAN NOT NULL DEFAULT true,  -- Update org docs on file changes

  -- Change tracking
  changes_cursor  TEXT,                       -- Provider-specific cursor (pageToken for GDrive)
  watch_channel_id TEXT,                      -- Active push notification channel
  watch_expiry    TIMESTAMPTZ,                -- When to renew the watch

  -- Metadata
  label           TEXT,                       -- Human label (e.g., "Engineering Shared Drive")
  metadata_json   JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, project_id, provider, root_folder_id)
);

CREATE INDEX idx_cloud_fs_mounts_org ON cloud_fs_mounts(org_id);
CREATE INDEX idx_cloud_fs_mounts_project ON cloud_fs_mounts(project_id);
CREATE INDEX idx_cloud_fs_mounts_integration ON cloud_fs_mounts(integration_id);
```

### 4.2 Integration Record (Reuse Existing)

Google Drive OAuth uses the existing `integrations` table — same pattern as Slack:

```
integrations:
  id: int_xxx
  org_id: org_xxx
  provider: 'google_drive'
  account_id: <google-user-id-or-drive-id>
  tokens_json: {
    access_token: "ya29.xxx",
    refresh_token: "1//xxx",
    token_type: "Bearer",
    expiry_date: 1710000000000,
    scope: "https://www.googleapis.com/auth/drive"
  }
  settings_json: {
    connected_by_email: "admin@company.com",
    connected_by_name: "Admin User",
    domain: "company.com",       -- for Workspace orgs
    shared_drive_id: "0ABxxx",   -- if using a Shared Drive
  }
  status: 'active'
```

### 4.3 Channel-to-Project Mapping (Extend Existing)

Rather than a new table, extend the integration `settings_json` or use a lightweight mapping:

```sql
-- Migration: 00XXX_channel_project_mapping.sql

CREATE TABLE channel_project_mappings (
  id          TEXT PRIMARY KEY,              -- cpm_xxx
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,                 -- Slack channel ID
  channel_name TEXT,                         -- Cached name (for inference display)
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  mount_id    TEXT REFERENCES cloud_fs_mounts(id) ON DELETE SET NULL, -- Optional override
  subfolder   TEXT,                          -- Override path within the mount

  infer_from_name BOOLEAN NOT NULL DEFAULT false, -- Auto-match by channel name
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, channel_id)
);

CREATE INDEX idx_cpm_org ON channel_project_mappings(org_id);
CREATE INDEX idx_cpm_channel ON channel_project_mappings(channel_id);
```

---

## 5. Flows

### 5.1 Connect Google Drive (OAuth)

Mirrors the existing Slack OAuth flow exactly:

```
Admin:  GET /orgs/:org_id/integrations/google-drive/authorize
        → Redirect to Google OAuth consent screen
        → Scopes: https://www.googleapis.com/auth/drive
        → This is equivalent to full read/write for classic Drive files and folders
        → access_type=offline, prompt=consent

Google: GET /integrations/google-drive/oauth/callback?code=xxx&state=xxx
        → Exchange code for tokens
        → Store refresh_token in integrations.tokens_json (encrypted)
        → Return { ok: true, integration_id }
```

**CLI equivalent:**
```bash
eve integrations connect google-drive --org org_xxx
# Opens browser for OAuth consent
# Stores tokens server-side
```

### 5.2 Create a Mount

After connecting Google Drive, map a folder to an org or project:

```bash
# Org-level mount (all projects can access)
eve cloud-fs mount \
  --provider google-drive \
  --folder-id "0ABxxx" \
  --label "Company Shared Drive"

# Project-level mount (scoped to one project)
eve cloud-fs mount \
  --provider google-drive \
  --folder-id "1aBcDeFg" \
  --project proj_xxx \
  --label "Project Alpha Docs"

# List mounts
eve cloud-fs list

# Browse files
eve cloud-fs ls /                          # Root of mount
eve cloud-fs ls /Q1-Reports/               # Subfolder
eve cloud-fs ls --project proj_xxx /       # Project mount
```

**API:**
```
POST   /orgs/:org_id/cloud-fs/mounts          -- Create mount
GET    /orgs/:org_id/cloud-fs/mounts          -- List mounts
GET    /orgs/:org_id/cloud-fs/mounts/:id      -- Show mount details
DELETE /orgs/:org_id/cloud-fs/mounts/:id      -- Remove mount
PATCH  /orgs/:org_id/cloud-fs/mounts/:id      -- Update settings

GET    /orgs/:org_id/cloud-fs/browse           -- List files at path
GET    /orgs/:org_id/cloud-fs/download/:file_id -- Presigned download
```

### 5.3 The Filing Flow (Slack → Agent → Google Drive)

This is the crown jewel. A user drops a file in Slack. The agent processes it, asks where to file it, and puts it in the right place.

```
User (Slack #project-alpha):
  "Here's the Q4 board deck" [attaches board-deck.pdf]

        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ 1. GATEWAY: Slack webhook                               │
│    • Detects file in message                            │
│    • Downloads from Slack → uploads to Eve S3 staging   │
│    • Routes to filing agent (channel listener or @eve)  │
│    • Creates thread for conversation                    │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│ 2. INGEST: Create ingest record                         │
│    • source_channel: 'slack'                            │
│    • File already in S3 from gateway resolution         │
│    • Emit system.doc.ingest event                       │
│    • Includes channel context for project inference     │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│ 3. WORKFLOW: process-and-file                           │
│    • Triggered by system.doc.ingest                     │
│    • Step 1: Extract & classify (doc_processor agent)   │
│    • Step 2: File to cloud FS (filing_agent)            │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│ 4. FILING AGENT: Decides where to put it                │
│                                                         │
│    a. Read channel → project mapping                    │
│       #project-alpha → proj_xxx → mount cfm_yyy         │
│                                                         │
│    b. Analyze content:                                  │
│       "Board deck, Q4 2025, financial summary"          │
│                                                         │
│    c. Browse existing folder structure:                  │
│       /Board Materials/                                 │
│       /Board Materials/2025-Q3/                         │
│       /Board Materials/2025-Q4/  ← exists!              │
│                                                         │
│    d. Confident? → File directly                        │
│       Unsure? → Ask human (step 5)                      │
│                                                         │
│    e. Upload to Google Drive:                            │
│       /Board Materials/2025-Q4/board-deck.pdf           │
│                                                         │
│    f. Update org docs index with metadata               │
└─────────────┬───────────────────────────────────────────┘
              │ (if unsure)
              ▼
┌─────────────────────────────────────────────────────────┐
│ 5. HITL: Agent asks in the Slack thread                 │
│                                                         │
│    Agent: "I found this looks like a Q4 board deck.     │
│            Should I file it under:                      │
│            1. /Board Materials/2025-Q4/                 │
│            2. /Finance/Reports/                         │
│            3. Somewhere else? (tell me the path)"       │
│                                                         │
│    Human: "1"                                           │
│                                                         │
│    Agent: "Filed to /Board Materials/2025-Q4/           │
│            board-deck.pdf. Added to the project index." │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Channel Name → Project Inference

When no explicit channel mapping exists, the agent can infer the project from the Slack channel name:

```
Channel: #eng-project-alpha
                   ↓ strip common prefixes (eng-, team-, proj-)
          project-alpha
                   ↓ fuzzy match against org's projects
          project: "Alpha" (slug: alpha)
                   ↓ look up mount
          mount: cfm_xxx → Google Drive folder /Projects/Alpha/
```

**Implementation**: The filing agent has a tool `resolve_filing_target` that:
1. Checks `channel_project_mappings` for an explicit mapping
2. Falls back to channel-name inference against project slugs
3. Falls back to the org-level default mount
4. If all fail, asks the human

### 5.6 Duplicate and Retry Safety

Ingested files can be delivered multiple times due to webhook retries and workflow replays. Add a dedupe layer:

- Compute `ingest_dedupe_key` from `(org_id, source_channel, source_file_id, source_message_ts, file_sha256)`.
- Skip duplicate workflows when the key is already `done`.
- Store `ingest_attempt_count`, retry reason, and last status in the ingest record for auditability.
- Add a reconciliation job for partial state (Drive write succeeded but index update failed, or vice versa).

### 5.7 Change Watching (Google Drive → Eve)

When files change in Google Drive externally (someone uploads via the Google Drive UI), Eve detects and indexes them:

```
Google Drive: File created/modified/deleted in watched folder
        │
        ▼ (push notification or poll)
┌─────────────────────────────────────────────────┐
│ Change Watcher Service                          │
│   • Receives notification (headers only)        │
│   • Calls changes.list with stored cursor       │
│   • For each changed file:                      │
│     - Emit system.cloud_fs.file.created/        │
│       modified/deleted event                    │
│   • Update cursor                               │
└──────────┬──────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────┐
│ Index Update Workflow                           │
│   • Triggered by system.cloud_fs.file.* events  │
│   • Downloads file metadata (not content)       │
│   • Updates org doc at /cloud-fs-index/{path}   │
│   • For content-heavy files, triggers ingest    │
│     for full extraction                         │
└─────────────────────────────────────────────────┘
```

---

## 6. Agent Tools

The filing agent (and any agent in the org) accesses cloud FS through **tools** injected into the harness environment. These are exposed via the resource URI pattern already used for `--with-apis`.

### 6.1 Tool Interface

```typescript
interface CloudFsTools {
  // Browse
  'cloud_fs.list'(params: {
    mount_id?: string;          // Specific mount (default: org mount)
    path: string;               // Folder path within mount
    recursive?: boolean;        // List subdirectories
    mime_type?: string;         // Filter by type
  }): Promise<CloudFsEntry[]>;

  // Read
  'cloud_fs.read'(params: {
    mount_id?: string;
    file_id: string;            // Provider file ID
  }): Promise<{ url: string; mime_type: string; name: string }>;

  // Write
  'cloud_fs.write'(params: {
    mount_id?: string;
    parent_path: string;        // Target folder path
    file_name: string;
    source: string;             // eve-storage:// URI or inline content
    mime_type?: string;
    description?: string;       // Drive file description
  }): Promise<{ file_id: string; path: string; web_url: string }>;

  // Move
  'cloud_fs.move'(params: {
    mount_id?: string;
    file_id: string;
    target_path: string;        // New parent folder path
    new_name?: string;          // Optional rename
  }): Promise<{ file_id: string; path: string }>;

  // Create folder
  'cloud_fs.mkdir'(params: {
    mount_id?: string;
    path: string;               // Full path to create
  }): Promise<{ folder_id: string; path: string }>;

  // Search
  'cloud_fs.search'(params: {
    mount_id?: string;
    query: string;              // Full-text search within mount
    mime_type?: string;
  }): Promise<CloudFsEntry[]>;

  // Resolve filing target
  'cloud_fs.resolve_target'(params: {
    channel_id?: string;        // Slack channel for inference
    channel_name?: string;
    project_id?: string;        // Explicit project
  }): Promise<{
    mount_id: string;
    root_path: string;
    project_name?: string;
    confidence: 'exact' | 'inferred' | 'default';
  }>;
}

interface CloudFsEntry {
  id: string;                   // Provider file ID
  name: string;
  path: string;                 // Path within mount
  mime_type: string;
  size_bytes?: number;
  modified_at: string;
  web_url: string;              // Link to open in browser
  is_folder: boolean;
}
```

### 6.2 Tool Delivery

Tools are delivered to agents the same way `--with-apis` works today:

1. **Manifest declaration**: Agent declares `cloud_fs` in its capabilities
2. **Provisioning**: When the job starts, the invoke service checks if the org has cloud FS mounts
3. **Injection**: Cloud FS tool definitions are injected into the agent's tool-home
4. **Authentication**: The agent's tool calls are proxied through the API, which handles token refresh
5. **Scoping**: Tools are scoped to mounts the agent's project has access to

```yaml
# In agent definition
agents:
  - slug: filing-agent
    capabilities:
      - cloud_fs        # Opt-in to cloud FS tools
      - org_docs         # Can update the index
```

---

## 7. Filing Agent Pack Extension

The ingest-agentpack gets a new agent and an extended workflow:

### 7.1 New Agent: `filing-agent`

```yaml
# eve/agents.yaml (extended)
- slug: filing-agent
  skill: filing-agent
  harness_profile: ingest
  description: "Files documents to the correct location in the org's cloud storage. Classifies content, infers target folder, asks for clarification when unsure."
  capabilities:
    - cloud_fs
    - org_docs
  policies:
    permission_policy: auto_edit
    git:
      commit: never
      push: never
```

### 7.2 New Skill: `filing-agent`

### 7.3 Cloud FS Tool Contract

Tool calls should return a normalized envelope for predictable agent handling:

```typescript
type CloudFsToolResult<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code:
      | 'NOT_FOUND'
      | 'PERMISSION_DENIED'
      | 'VALIDATION_ERROR'
      | 'WRITE_PROHIBITED'
      | 'PROVIDER_ERROR'
      | 'DUPLICATE';
    message: string;
    details?: Record<string, unknown>;
  };
};
```

Required behavior:

- Write tools (`cloud_fs.write`, `cloud_fs.create_folder`, `cloud_fs.move`) must reject operations when mount mode is not write-allowed.
- Write calls should include an optional `idempotency_key` (use `ingest_id` when available).
- Error payloads must be sanitized: include machine-readable codes and redact provider internals.
- Tool output should include provider IDs (`file_id`, `folder_id`) and a `resource_uri` so events/index can correlate state.


```markdown
# skills/filing-agent/SKILL.md

You are a document filing agent. Your job is to take a processed document
and file it in the correct location in the organization's cloud storage.

## Input

You receive:
- Processed document analysis (from doc_processor): summary, key_facts, entities
- File in Eve staging storage (eve-storage:// URI)
- Channel context (Slack channel name, project mapping)
- User instructions (if any)

## Process

1. **Resolve target**: Call `cloud_fs.resolve_target` with the channel context
   to determine which mount and root folder to use.

2. **Browse existing structure**: Call `cloud_fs.list` on the target mount
   to understand the folder hierarchy. Look for logical homes for the document.

3. **Classify and decide**:
   - If the document clearly belongs in an existing folder → file it
   - If a new subfolder should be created → create it, then file
   - If you're unsure → ask the human in the thread

4. **File the document**: Call `cloud_fs.write` to upload to the target folder.

5. **Update the index**: Write/update an org doc at the path
   `/cloud-fs-index/{mount_label}/{relative_path}` with:
   - Summary from the doc_processor
   - Key facts and entities
   - File location (cloud FS path + web URL)
   - Filing date and who submitted it

## Confidence Levels

- **High confidence** (file directly):
  - Exact folder match exists (e.g., "Q4 Reports" folder + Q4 report document)
  - User gave explicit instructions ("put it in /Board Materials")
  - Channel mapping has a specific subfolder configured

- **Low confidence** (ask human):
  - Multiple plausible locations exist
  - Document type doesn't match any existing folder
  - Channel has no project mapping and name inference is ambiguous

## Asking for Clarification

When unsure, reply in the Slack thread with options:

"I've analyzed this document: [2-sentence summary]

Where should I file it?
1. /Board Materials/2025-Q4/ (matches "board" + "Q4" in content)
2. /Finance/Reports/ (contains financial data)
3. Tell me a specific path

Reply with a number or a path."

## Output

After filing, confirm in the thread:

"Filed: board-deck.pdf → /Board Materials/2025-Q4/
 View: [Google Drive link]
 Index updated at /cloud-fs-index/company-drive/board-materials/2025-q4/board-deck"
```

### 7.4 Extended Workflow

```yaml
# eve/workflows.yaml (extended)
workflows:
  process-document:
    trigger:
      system:
        event: doc.ingest
    steps:
      - agent:
          name: doc_processor
          prompt: "Process the ingested document using your doc-processor skill."

  process-and-file:
    trigger:
      system:
        event: doc.ingest
    conditions:
      # Only run when org has cloud FS mounts configured
      - check: org.has_cloud_fs_mounts
    steps:
      - agent:
          name: doc_processor
          prompt: "Process the ingested document using your doc-processor skill."
      - agent:
          name: filing_agent
          prompt: "File the processed document to the appropriate cloud storage location."
          depends_on: [doc_processor]
          # Filing agent receives doc_processor's output as input
```

---

## 8. Permission Model

### 8.1 Eve RBAC Integration

Cloud FS operations integrate with the existing permission model:

| Permission | Scope | Operations |
|---|---|---|
| `cloud_fs:read` | org or project | Browse, download, search |
| `cloud_fs:write` | org or project | Upload, move, create folders |
| `cloud_fs:admin` | org | Create/delete mounts, manage connections |
| `integrations:write` | org | Connect/disconnect Google Drive |

### 8.2 Access Group Scoping

Mounts can be scoped to access groups, just like org docs paths:

```yaml
# .eve/access.yaml
groups:
  engineering:
    cloud_fs:
      - mount: "Engineering Drive"
        mode: read_write
  finance:
    cloud_fs:
      - mount: "Finance Drive"
        mode: read_only  # Can view but not file here
```

### 8.3 Agent Permissions

Agents inherit their project's cloud FS access. An agent in project "Alpha" can only access:
1. Mounts explicitly assigned to project "Alpha"
2. Org-level mounts (shared across all projects)
3. Within the mode constraints (read_only, write_only, read_write)

### 8.4 Google Drive Permission Mapping

Eve does **not** manage Google Drive permissions — it operates within the permissions of the connecting user's OAuth token. This means:
- The connecting admin's Google Drive permissions = the ceiling of what Eve can access
- If the admin can't see a folder, Eve can't either
- Shared Drives are recommended because they survive employee turnover

### 8.5 Inference Controls

- Channel-name inference is opt-in, not default, unless the org explicitly enables it.
- Inference should only run against allowlisted channel prefixes/suffixes to reduce accidental matches.
- If both explicit mapping and inference exist, explicit mapping must always win.
- Auto-filing in `low confidence` states must pause and request human confirmation before writing.
- Include confidence score and rationale when prompting humans in Slack.

---

## 9. Google Drive Provider Implementation

### 9.1 OAuth Flow

```typescript
// apps/api/src/integrations/google-drive-oauth.controller.ts

@Controller()
export class GoogleDriveOAuthController {

  @RequirePermission('integrations:write')
  @Get('orgs/:org_id/integrations/google-drive/authorize')
  @Redirect()
  authorize(@Param('org_id') orgId: string): { url: string } {
    // Generate state token (existing pattern from Slack OAuth)
    const state = this.integrationsService.generateOAuthState(orgId);

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.EVE_GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${apiUrl}/integrations/google-drive/oauth/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/drive');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    url.searchParams.set('include_granted_scopes', 'true');

    return { url: url.toString() };
  }

  @Public()
  @Get('integrations/google-drive/oauth/callback')
  async callback(@Query('code') code, @Query('state') state) {
    // Validate state → orgId
    // Exchange code for tokens at https://oauth2.googleapis.com/token
    // Store in integrations table as provider='google_drive'
    // Return success
  }
}
```

### 9.2 Provider Interface

```typescript
// packages/shared/src/cloud-fs/cloud-fs-provider.ts

export interface CloudFsProvider {
  readonly providerName: string;

  // Authentication
  getAccessToken(integration: Integration): Promise<string>;
  refreshToken(integration: Integration): Promise<TokenResult>;

  // File operations
  listFiles(token: string, folderId: string, options?: ListOptions): Promise<CloudFsEntry[]>;
  getFile(token: string, fileId: string): Promise<FileMetadata>;
  downloadFile(token: string, fileId: string): Promise<ReadableStream>;
  uploadFile(token: string, parentId: string, name: string, content: Buffer, mimeType: string): Promise<CloudFsEntry>;
  moveFile(token: string, fileId: string, newParentId: string, newName?: string): Promise<CloudFsEntry>;
  createFolder(token: string, parentId: string, name: string): Promise<CloudFsEntry>;
  deleteFile(token: string, fileId: string): Promise<void>;
  searchFiles(token: string, rootId: string, query: string): Promise<CloudFsEntry[]>;

  // Path resolution (folder IDs ↔ human-readable paths)
  resolvePath(token: string, rootId: string, path: string): Promise<string>; // returns folderId
  buildPath(token: string, fileId: string): Promise<string>; // returns /path/from/root

  // Change detection
  getChangesStartToken(token: string, driveId?: string): Promise<string>;
  listChanges(token: string, pageToken: string): Promise<ChangeResult>;
  createWatchChannel(token: string, channelId: string, webhookUrl: string, pageToken: string): Promise<WatchChannel>;
  stopWatchChannel(token: string, channelId: string, resourceId: string): Promise<void>;
}
```

### 9.3 Token Refresh

Automatic token refresh with expiry tracking:

```typescript
// Token refresh happens transparently before any operation
async ensureValidToken(integration: Integration): Promise<string> {
  const tokens = integration.tokens_json;
  if (tokens.expiry_date > Date.now() + 60_000) {
    return tokens.access_token; // Still valid (with 60s buffer)
  }

  // Refresh
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.EVE_GOOGLE_CLIENT_ID,
      client_secret: config.EVE_GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const newTokens = await response.json();
  await this.integrations.updateTokens(integration.id, {
    ...tokens,
    access_token: newTokens.access_token,
    expiry_date: Date.now() + (newTokens.expires_in * 1000),
  });

  return newTokens.access_token;
}
```

---

## 10. Staging Area Pattern

When files arrive from Slack, they're already in Eve S3 (the gateway resolves them). The filing agent treats Eve S3 as the **staging area**:

```
File lifecycle:
  Slack → Eve S3 (staging) → Agent processes → Google Drive (final)
                                    ↓
                              Org Docs (index)
```

The file stays in S3 staging until the agent confirms filing. If the agent needs to ask the human, the file persists in S3 (ingest record status = `processing`). After filing to Google Drive, the ingest record status → `done`.

**Retention**: Staged files in S3 are retained for 30 days after filing (for audit trail). The ingest record provides the paper trail.

---

## 11. Channel → Project → Folder Chain

The automatic routing chain:

```
Slack Channel #eng-alpha
        │
        ▼ channel_project_mappings (explicit)
   OR   ▼ channel name inference (fuzzy)
        │
    Project: Alpha (proj_xxx)
        │
        ▼ cloud_fs_mounts (project-level)
   OR   ▼ cloud_fs_mounts (org-level, default)
        │
    Mount: cfm_yyy → Google Drive folder 0ABxxx
        │
        ▼ channel_project_mappings.subfolder (override)
   OR   ▼ project slug as subfolder (convention)
        │
    Target folder: /Projects/Alpha/
```

### CLI Setup

```bash
# Map a channel to a project
eve cloud-fs map-channel \
  --channel C0123ABCDEF \
  --project proj_xxx \
  --subfolder "/Incoming"

# Auto-map channels by name pattern
eve cloud-fs auto-map \
  --pattern "proj-{slug}" \
  --mount cfm_xxx

# List current mappings
eve cloud-fs channel-mappings
```

---

## 12. Index/Embedding Integration

When a file is filed, the agent updates the org docs index:

```
Org Doc Path: /cloud-fs-index/{mount-label}/{relative-path-without-extension}
```

**Example:**
```
Filed: board-deck.pdf → Google Drive /Board Materials/2025-Q4/board-deck.pdf
Index: /cloud-fs-index/company-drive/board-materials/2025-q4/board-deck
```

**Index document content (Markdown):**

```markdown
# Board Deck - Q4 2025

**Filed**: 2026-03-14 by @adam via Slack #project-alpha
**Location**: Google Drive → /Board Materials/2025-Q4/board-deck.pdf
**View**: https://drive.google.com/file/d/xxx/view
**Type**: application/pdf (2.4 MB, 42 pages)

## Summary
Quarterly board deck covering financial performance, product roadmap,
and strategic initiatives for Q4 2025.

## Key Facts
- Revenue grew 23% QoQ to $4.2M
- Three new enterprise customers signed
- Mobile app launch scheduled for Q1 2026

## Entities
- @CFO (presenter)
- Board of Directors (audience)
- Project Phoenix (referenced initiative)

## Action Items
- [ ] Finalize Q1 budget by Jan 15
- [ ] Schedule follow-up with investor relations
```

**Metadata (JSONB):**
```json
{
  "cloud_fs_mount_id": "cfm_xxx",
  "cloud_fs_file_id": "1aBcDeFg",
  "cloud_fs_provider": "google_drive",
  "cloud_fs_web_url": "https://drive.google.com/file/d/xxx/view",
  "source_channel": "slack",
  "filed_by": "user_xxx",
  "original_file_name": "board-deck.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 2516582,
  "ingest_id": "ing_xxx"
}
```

This means:
- **Full-text search** works immediately (PostgreSQL tsvector)
- **Semantic search** works when embeddings are generated
- **Structured queries** find files by metadata (mount, provider, type, date)
- **Agent queries** can ask "what board decks do we have?" and get results from org docs

---

## 13. Implementation Phases

### Phase 1: Foundation (1-2 weeks)

**Goal**: Connect Google Drive and browse files via CLI.

- [ ] Google Drive OAuth controller (mirror Slack pattern)
- [ ] `cloud_fs_mounts` migration and CRUD
- [ ] Google Drive provider (list, get, download, upload, move, mkdir, search)
- [ ] Token refresh middleware
- [ ] Watcher/webhook verification and reconciliation job
- [ ] Cloud FS API endpoints (mount CRUD + browse/download)
- [ ] CLI commands: `eve integrations connect google-drive`, `eve cloud-fs mount`, `eve cloud-fs ls`, `eve cloud-fs list`
- [ ] RBAC: `cloud_fs:read`, `cloud_fs:write`, `cloud_fs:admin` permissions

### Phase 2: Filing Agent (1-2 weeks)

**Goal**: Drop a file in Slack, agent files it to Google Drive.

- [ ] Agent cloud FS tools (tool-home injection pattern)
- [ ] `filing-agent` skill and agent definition in ingest-agentpack
- [ ] `process-and-file` workflow
- [ ] `channel_project_mappings` table and API
- [ ] Channel name → project inference logic
- [ ] `cloud_fs.resolve_target` tool implementation
- [ ] Org docs index update on filing
- [ ] CLI: `eve cloud-fs map-channel`, `eve cloud-fs channel-mappings`
- [ ] Dedupe key (`ingest_dedupe_key`) to prevent double-filing on retries

### Phase 3: Intelligence (1 week)

**Goal**: Smart filing with HITL, change watching.

- [ ] HITL flow: agent asks clarifying questions in Slack thread
- [ ] Confidence scoring for filing decisions
- [ ] Google Drive change watcher (hybrid push + poll)
- [ ] `system.cloud_fs.file.*` events from external changes
- [ ] Auto-indexing workflow for external changes
- [ ] Watch channel renewal scheduler

### Phase 4: Polish & Extend (ongoing)

**Goal**: Production hardening, additional providers.

- [ ] Rate limiting per org (protect shared Google quota)
- [ ] Bulk file operations (move multiple, create folder trees)
- [ ] Box provider implementation
- [ ] OneDrive provider implementation
- [ ] Google Workspace domain-wide delegation (enterprise tier)
- [ ] Folder permission sync (Google Drive ACLs ↔ Eve access groups)
- [ ] CLI: `eve cloud-fs upload`, `eve cloud-fs mv`, `eve cloud-fs search`

---

## 14. Configuration Requirements

### Environment Variables

```bash
# Google OAuth (required for Google Drive integration)
EVE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
EVE_GOOGLE_CLIENT_SECRET=GOCSPX-xxx

# Google Drive webhook (for change watching)
EVE_GOOGLE_DRIVE_WEBHOOK_URL=https://api.eve.example.com/webhooks/google-drive
EVE_GOOGLE_DRIVE_WEBHOOK_TOKEN=strong-random-hex-token
```

### Google Cloud Project Setup

1. Create a GCP project (or reuse existing)
2. Enable the Google Drive API
3. Create OAuth 2.0 credentials (Web application type)
4. Set authorized redirect URI: `{EVE_API_URL}/integrations/google-drive/oauth/callback`
5. Configure OAuth consent screen (external, publish to production for long-lived tokens)
6. For change watching: verify webhook domain ownership

### Manifest Integration

```yaml
# .eve/manifest.yaml — project using cloud FS
x-eve:
  packs:
    - source: github:eve-horizon/ingest-agentpack@v2
  agents:
    filing_agent:
      capabilities:
        - cloud_fs
        - org_docs
```

---

## 15. Security Considerations

| Concern | Mitigation |
|---|---|
| **Token storage** | Refresh tokens encrypted at rest (same as Slack tokens) |
| **Token scope** | Request minimum required scope; bounded by connecting user's permissions |
| **Agent access** | Agents only access mounts their project is allowed to use |
| **File content** | Files pass through Eve S3 as staging; not permanently stored unless explicitly configured |
| **Webhook spoofing** | Validate `X-Goog-Channel-Token` matches org's channel token |
| **Rate limiting** | Per-org and per-provider rate limiting with token-bucket/backoff and jitter |
| **Token revocation** | If refresh fails → mark integration as `needs_reauth`, notify admin |
| **Data residency** | Files in Google Drive stay in Google Drive; only metadata/index in Eve |
| **Replay / retries** | Enforce idempotency keys and dedupe state for webhook/workflow replays |

### 15.1 Watcher and Callback Reliability

- Treat webhook notifications as hints and reconcile against provider change cursors before indexing.
- Verify callbacks with `X-Goog-Channel-Token`, resource IDs, and optional request-body integrity checks.
- Persist watch channel metadata and renew before `watch_expiry`; re-register when expiry is missed.
- Add a periodic fallback poll to heal missed notifications and backfill changes.

---

## 16. Future Vision

### Multi-Provider Filing

```bash
# File to Google Drive
@eve file this to google-drive:/Board Materials/Q4

# File to Box
@eve file this to box:/Legal/Contracts/2026

# File to both (backup)
@eve file this to google-drive:/Reports/ and box:/Reports/
```

### Smart Folder Organization

The filing agent learns from patterns:
- "Every Monday, the team uploads a standup summary → /Standups/2026-W{n}/"
- "PDFs from #finance always go to /Finance/Receipts/{month}/"
- "Images from #design go to /Design/Assets/ with auto-naming"

### Cross-System Search

```bash
# Search across org docs, cloud FS index, and ingested files
eve search "Q4 board deck" --scope all

Results:
  1. [Org Doc] /cloud-fs-index/company-drive/board-materials/q4-board-deck
  2. [Google Drive] /Board Materials/2025-Q4/board-deck.pdf
  3. [Ingest] ing_xxx — board-deck.pdf (processed 2025-10-15)
```

### Automated Retention Policies

```yaml
# .eve/manifest.yaml
cloud_fs:
  retention:
    /Temp/: { max_age: 30d, action: archive }
    /Archive/: { max_age: 365d, action: delete }
```

---

## 17. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth model | Per-org OAuth consent (3LO) | Works for all Google accounts; matches Slack pattern; no admin console config needed |
| Scope | `drive` (full read/write) | Required for folder watching and arbitrary filing; `drive.file` too restrictive |
| Storage model | Mount-based (folder ↔ project) | Maps cleanly to Eve's org/project hierarchy |
| Agent access | Tool injection (not env vars) | Secure, scoped, auditable; matches `--with-apis` pattern |
| Filing intelligence | Agent-driven (not rules) | More flexible than regex rules; handles ambiguity via HITL |
| Index location | Org docs | Reuses existing FTS + semantic search; no new index infrastructure |
| Change detection | Hybrid push + poll | Push alone unreliable; poll alone wasteful; hybrid is robust |
| Staging area | Eve S3 (existing ingest bucket) | Already works; no new infrastructure; audit trail via ingest records |
| Provider abstraction | Interface + per-provider implementation | Future-proofs for Box, OneDrive without touching agents |

---

## Appendix A: Event Types

| Event | Trigger | Payload |
|---|---|---|
| `system.doc.ingest` | File uploaded (existing) | `{ingest_id, file_name, mime_type, ...}` |
| `system.cloud_fs.file.created` | File added to watched folder | `{mount_id, file_id, path, name, mime_type}` |
| `system.cloud_fs.file.modified` | File updated in watched folder | `{mount_id, file_id, path, name, mime_type}` |
| `system.cloud_fs.file.deleted` | File removed from watched folder | `{mount_id, file_id, path, name}` |
| `system.cloud_fs.mount.connected` | New mount created | `{mount_id, provider, root_folder_path}` |

## Appendix B: CLI Commands

```bash
# Integration management
eve integrations connect google-drive [--org org_xxx]
eve integrations disconnect google-drive [--org org_xxx]
eve integrations list

# Mount management
eve cloud-fs mount --provider google-drive --folder-id ID [--project proj_xxx] [--label "Label"]
eve cloud-fs unmount MOUNT_ID
eve cloud-fs list                             # List all mounts

# File operations
eve cloud-fs ls [PATH] [--mount MOUNT_ID]    # Browse files
eve cloud-fs cat FILE_ID                      # Download/view file
eve cloud-fs upload FILE [--to PATH]          # Upload to mount
eve cloud-fs mv FILE_ID --to PATH             # Move file
eve cloud-fs mkdir PATH                       # Create folder
eve cloud-fs search QUERY                     # Search files

# Channel mapping
eve cloud-fs map-channel --channel CHANNEL_ID --project proj_xxx [--subfolder PATH]
eve cloud-fs unmap-channel --channel CHANNEL_ID
eve cloud-fs auto-map --pattern "proj-{slug}" --mount MOUNT_ID
eve cloud-fs channel-mappings                 # List mappings
```

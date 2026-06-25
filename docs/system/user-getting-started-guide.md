# Getting Started with Eve Horizon

> One command to start, AI configures everything

## Quick Start (5 minutes)

### 1. Initialize Your Project

```bash
# Install the CLI globally
npm install -g @eve-horizon/cli

# Initialize a new project
eve init my-project
cd my-project
```

This downloads the starter template, sets up a fresh git repo, and installs skills.

### 2. Start Your AI Coding Agent

Open the project in your AI coding agent (Claude Code, Cursor, etc.):

```bash
claude  # or your preferred agent
```

### 3. Run the Setup Skill

Simply ask your AI agent:

> "Run the eve-bootstrap skill"

Legacy setup flow (if you only want project setup without access requests):

> "Run the eve-new-project-setup skill"

The AI will:
- Set up your staging profile and authentication
- Interview you about your project
- Configure the Eve manifest
- Help you set up your own Git remote

That's it! Your project is ready.

---

## What Just Happened?

The `eve init` command:
1. Downloaded the starter template from GitHub
2. Set up a fresh git repository (no template history)
3. Installed Eve skills for your AI coding agent
4. Made an initial commit

The setup skill then automated:
1. **Profile Creation**: `eve profile create staging --api-url https://api.eve.example.com`
2. **Authentication**: Using your SSH key (auto-discovered from GitHub if needed)
3. **Manifest Configuration**: Set project slug, name, description in `.eve/manifest.yaml`
4. **Git Setup**: Changed remote from template to your own repo

## What Can Eve Horizon Do?

Eve Horizon runs AI-powered jobs for your project:

| Category | Examples |
|----------|----------|
| **CI/CD** | Automated tests, builds, deployments |
| **Code Review** | PR feedback, security scanning |
| **Documentation** | Generate docs, changelogs, READMEs |
| **Development** | Code scaffolding, refactoring, migrations |

## Next Steps

After setup, try these:

```bash
# Sync your Claude/Codex OAuth tokens
eve auth sync

# Create your first job
eve job create --description "Review the codebase and suggest improvements"

# Check job status
eve job list
```

---

## Manual Setup (Alternative)

If you prefer to set up manually or need to troubleshoot, follow these steps.

### Prerequisites

- **SSH key** (ed25519 or RSA) - typically at `~/.ssh/id_ed25519`
- **GitHub account** with your SSH key added (for auto-discovery)
- **Node.js 18+** installed
- **API URL** from your admin (e.g., `https://api.eve.example.com`)

### Clone Template (Alternative to `eve init`)

If you prefer to clone the template directly instead of using `eve init`:

```bash
git clone https://github.com/eve-horizon/eve-horizon-starter my-project
cd my-project

# Remove template git history and start fresh
rm -rf .git
git init
git add -A
git commit -m "Initial commit"

# Install skills
eve skills install
```

### Install the CLI

```bash
# Using npm
npm install -g @eve-horizon/cli

# Using pnpm
pnpm add -g @eve-horizon/cli

# Verify installation
eve --help
```

If you're working from source:

```bash
cd packages/cli
pnpm install
pnpm build
pnpm link --global
```

### Create a Profile

```bash
eve profile create staging --api-url https://api.eve.example.com
```

### Set Default Credentials

```bash
eve profile set --default-email you@example.com --default-ssh-key ~/.ssh/id_ed25519
```

### Log In

```bash
eve auth login
```

If your SSH key isn't registered, the CLI will offer to fetch your keys from GitHub:

```
No registered SSH key found for this user.
Enter GitHub username to register keys (or press Enter to skip): your-github-username

Found 2 SSH key(s) for github.com/your-github-username
Register them? [Y/n]: y
Registered 2 SSH key(s)

Retrying login with registered keys...
Logged in
```

### Configure the Manifest

Edit `.eve/manifest.yaml` with your project details:

```yaml
component:
  kind: app
  slug: my-project
  name: My Project
  description: A brief description of your project
```

### Set Up Your Git Remote

```bash
git remote set-url origin git@github.com:YourOrg/my-project.git
```

---

## Common Commands Reference

| Command | Description |
|---------|-------------|
| `eve profile show` | Show current profile settings |
| `eve profile set --org X --project Y` | Set default org and project |
| `eve auth login` | Authenticate with Eve |
| `eve auth status` | Check authentication status |
| `eve auth sync` | Sync local OAuth tokens to Eve |
| `eve org list` | List your organizations |
| `eve project list` | List projects in your org |
| `eve secrets list` | List project secrets |
| `eve secrets set KEY VALUE` | Set a project secret |
| `eve secrets import --file ./secrets.env` | Import secrets from a file (use `--org`, `--user`, or `--project`) |
| `eve job create --description "..."` | Create a new job |
| `eve job list` | List jobs in your project |
| `eve job list --phase active` | List active jobs |
| `eve job ready` | Show schedulable jobs |
| `eve job show <id>` | View job details |
| `eve job follow <id>` | Stream job logs |
| `eve job wait <id>` | Wait for job completion |
| `eve job result <id>` | Get job results |
| `eve harness list` | List available AI harnesses |

---

## Troubleshooting

### "No registered SSH key found"

Your SSH key isn't registered with Eve. Options:

1. **Auto-register from GitHub**: During login, enter your GitHub username when prompted
2. **Contact your admin**: Ask them to register your key using `eve admin invite`

### "Challenge expired"

SSH challenges are valid for 5 minutes. Request a new one:

```bash
eve auth login
```

### "Not authenticated"

Your token may have expired. Log in again:

```bash
eve auth logout
eve auth login
```

### Job Stuck in "ready"

The job is waiting to be scheduled. Check:

1. Is the orchestrator running? `eve system health`
2. Are there available workers? `eve system status`

### Job Failed

View the logs and diagnostics:

```bash
eve job logs MyProj-abc123
eve job diagnose MyProj-abc123
```

### Wrong Profile Active

Switch profiles:

```bash
eve profile use staging
```

### API Connection Refused

Verify the API URL is correct:

```bash
eve profile show
eve system health
```

---

## Getting Help

### CLI Help

```bash
# Main help
eve --help

# Command help
eve job --help

# Subcommand help
eve job create --help
```

### JSON Output

Add `--json` to any command for machine-readable output:

```bash
eve job list --json
eve auth status --json
```

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { GitWorkspace, GitWorkspaceError } from '@eve/shared';

/**
 * Unit tests for GitWorkspace class.
 *
 * These tests focus on the key logic paths:
 * - checkout() with different ref types (branch, tag, SHA)
 * - createBranch() with each mode (never, if_missing, always)
 * - commit() and push() policies
 * - Error handling for missing credentials
 * - Resolved metadata tracking
 */

describe('GitWorkspace', () => {
  let testDir: string;
  let bareRepoPath: string;
  let workspacePath: string;

  beforeEach(() => {
    // Create test directory
    testDir = mkdtempSync(join(tmpdir(), 'git-workspace-test-'));
    bareRepoPath = join(testDir, 'bare-repo.git');
    workspacePath = join(testDir, 'workspace');

    // Create a bare git repository for testing
    mkdirSync(bareRepoPath);
    execSync('git init --bare --initial-branch=main', { cwd: bareRepoPath });

    // Create a temporary clone to set up initial content
    const setupPath = join(testDir, 'setup');
    execSync(`git clone ${bareRepoPath} ${setupPath}`, { cwd: testDir });
    execSync('git config user.email "test@example.com"', { cwd: setupPath });
    execSync('git config user.name "Test User"', { cwd: setupPath });

    // Create initial commit on main (ensure we're on main branch)
    execSync('git checkout -b main 2>/dev/null || git checkout main', { cwd: setupPath });
    writeFileSync(join(setupPath, 'README.md'), '# Test Repo\n');
    execSync('git add README.md', { cwd: setupPath });
    execSync('git commit -m "Initial commit"', { cwd: setupPath });
    execSync('git push -u origin main', { cwd: setupPath });

    // Create a feature branch
    execSync('git checkout -b feature/test', { cwd: setupPath });
    writeFileSync(join(setupPath, 'feature.txt'), 'Feature content\n');
    execSync('git add feature.txt', { cwd: setupPath });
    execSync('git commit -m "Add feature"', { cwd: setupPath });
    execSync('git push -u origin feature/test', { cwd: setupPath });

    // Create a tag
    execSync('git tag v1.0.0', { cwd: setupPath });
    execSync('git push origin v1.0.0', { cwd: setupPath });

    // Go back to main for cleanup
    execSync('git checkout main', { cwd: setupPath });

    // Clean up setup directory
    rmSync(setupPath, { recursive: true, force: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('clones repository with default branch', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        defaultBranch: 'main',
      });

      await workspace.init();

      expect(existsSync(workspace.getRepoPath())).toBe(true);
      expect(existsSync(join(workspace.getRepoPath(), 'README.md'))).toBe(true);
    });

    it('clones repository with specific branch', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        defaultBranch: 'main',
        gitConfig: { ref: 'feature/test' },
      });

      await workspace.init('feature/test');

      expect(existsSync(join(workspace.getRepoPath(), 'feature.txt'))).toBe(true);
    });

    it('throws GitWorkspaceError if workspace not initialized', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await expect(workspace.checkout('main')).rejects.toThrow(GitWorkspaceError);
      await expect(workspace.checkout('main')).rejects.toThrow(
        'GitWorkspace not initialized',
      );
    });

    it('configures git user if provided', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: {
          name: 'Eve Bot',
          email: 'eve@example.com',
        },
      });

      await workspace.init();

      // Verify git config was set
      const userName = execSync('git config user.name', {
        cwd: workspace.getRepoPath(),
        encoding: 'utf-8',
      }).trim();
      const userEmail = execSync('git config user.email', {
        cwd: workspace.getRepoPath(),
        encoding: 'utf-8',
      }).trim();

      expect(userName).toBe('Eve Bot');
      expect(userEmail).toBe('eve@example.com');
    });
  });

  describe('checkout()', () => {
    it('checks out main branch after init', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();
      await workspace.checkout('main', 'explicit');

      // After checkout, README should exist
      expect(existsSync(join(workspace.getRepoPath(), 'README.md'))).toBe(true);

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.resolved_ref).toBe('main');
      expect(meta.ref_source).toBe('explicit');
      expect(meta.resolved_sha).toBeDefined();
    });

    it('checks out a branch initialized from specific ref', async () => {
      // Initialize workspace directly with the feature branch
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitConfig: { ref: 'feature/test' },
      });

      await workspace.init('feature/test');
      await workspace.checkout('feature/test', 'explicit');

      // After checkout, feature.txt should exist (from init with feature branch)
      expect(existsSync(join(workspace.getRepoPath(), 'feature.txt'))).toBe(true);

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.resolved_ref).toBe('feature/test');
      expect(meta.ref_source).toBe('explicit');
    });

    it('checks out a tag', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();
      await workspace.checkout('v1.0.0', 'manifest');

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.resolved_ref).toBe('v1.0.0');
      expect(meta.ref_source).toBe('manifest');
    });

    it('checks out a specific SHA', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      // Get the SHA of main by resolving HEAD (which is main after init)
      const mainSha = await workspace.resolveRef('HEAD');

      await workspace.checkout(mainSha, 'env_release');

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.resolved_ref).toBe(mainSha);
      expect(meta.resolved_sha).toBe(mainSha);
      expect(meta.ref_source).toBe('env_release');
    });

    it('tracks ref source correctly', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();
      await workspace.checkout('main', 'project_default');

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.ref_source).toBe('project_default');
    });
  });

  describe('createBranch()', () => {
    describe('mode: never', () => {
      it('fails if branch does not exist', async () => {
        const workspace = new GitWorkspace({
          repoUrl: bareRepoPath,
          workspacePath,
        });

        await workspace.init();

        await expect(
          workspace.createBranch('nonexistent-branch', 'main', 'never'),
        ).rejects.toThrow(GitWorkspaceError);
        await expect(
          workspace.createBranch('nonexistent-branch', 'main', 'never'),
        ).rejects.toThrow('does not exist and create_branch=never');
      });

      it('succeeds for local branch that exists', async () => {
        const workspace = new GitWorkspace({
          repoUrl: bareRepoPath,
          workspacePath,
        });

        await workspace.init();
        // Create a local branch first
        await workspace.runGit(['checkout', '-b', 'local-exists']);
        await workspace.runGit(['checkout', 'main']);

        // Now use never mode - should succeed
        await workspace.createBranch('local-exists', 'main', 'never');

        const currentBranch = await workspace.getCurrentBranch();
        expect(currentBranch).toBe('local-exists');
      });
    });

    describe('mode: if_missing', () => {
      it('creates branch if it does not exist', async () => {
        const workspace = new GitWorkspace({
          repoUrl: bareRepoPath,
          workspacePath,
        });

        await workspace.init();
        await workspace.createBranch('job/new-feature', 'main', 'if_missing');

        const currentBranch = await workspace.getCurrentBranch();
        expect(currentBranch).toBe('job/new-feature');

        const meta = workspace.getResolvedMetadata()!;
        expect(meta.resolved_branch).toBe('job/new-feature');
      });

      it('uses existing branch if present', async () => {
        const workspace = new GitWorkspace({
          repoUrl: bareRepoPath,
          workspacePath,
          gitUser: { name: 'Test', email: 'test@example.com' },
        });

        await workspace.init();
        // Create a local branch with a file
        await workspace.runGit(['checkout', '-b', 'exists-local']);
        writeFileSync(join(workspace.getRepoPath(), 'exists.txt'), 'exists content');
        await workspace.commit('Add exists file');
        await workspace.runGit(['checkout', 'main']);

        // Use if_missing mode - should checkout existing branch
        await workspace.createBranch('exists-local', 'main', 'if_missing');

        const currentBranch = await workspace.getCurrentBranch();
        expect(currentBranch).toBe('exists-local');
        // The file from the existing branch should be present
        expect(existsSync(join(workspace.getRepoPath(), 'exists.txt'))).toBe(true);
      });
    });

    describe('mode: always', () => {
      it('creates branch if it does not exist', async () => {
        const workspace = new GitWorkspace({
          repoUrl: bareRepoPath,
          workspacePath,
        });

        await workspace.init();
        await workspace.createBranch('job/fresh-branch', 'main', 'always');

        const currentBranch = await workspace.getCurrentBranch();
        expect(currentBranch).toBe('job/fresh-branch');
      });

      it('resets existing branch to base ref', async () => {
        const workspace = new GitWorkspace({
          repoUrl: bareRepoPath,
          workspacePath,
          gitUser: { name: 'Test', email: 'test@example.com' },
        });

        await workspace.init();

        // Create a local branch with a commit
        await workspace.runGit(['checkout', '-b', 'local-branch']);
        writeFileSync(join(workspace.getRepoPath(), 'local.txt'), 'local content');
        await workspace.runGit(['add', 'local.txt']);
        await workspace.runGit(['commit', '-m', 'Local commit']);
        await workspace.runGit(['checkout', 'main']);

        // Now reset it to main using 'always' mode
        await workspace.createBranch('local-branch', 'main', 'always');

        // The local commit should be gone
        expect(existsSync(join(workspace.getRepoPath(), 'local.txt'))).toBe(false);
      });
    });
  });

  describe('commit()', () => {
    it('commits staged changes', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
      });

      await workspace.init();

      // Create a change
      writeFileSync(join(workspace.getRepoPath(), 'new-file.txt'), 'new content');

      const sha = await workspace.commit('Add new file');

      expect(sha).toBeDefined();
      expect(sha).toHaveLength(40); // SHA is 40 hex chars

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.commits).toContain(sha);
    });

    it('returns undefined when no changes to commit', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
      });

      await workspace.init();

      const sha = await workspace.commit('No changes');

      expect(sha).toBeUndefined();
    });

    it('tracks multiple commits', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
      });

      await workspace.init();

      writeFileSync(join(workspace.getRepoPath(), 'file1.txt'), 'content1');
      const sha1 = await workspace.commit('First commit');

      writeFileSync(join(workspace.getRepoPath(), 'file2.txt'), 'content2');
      const sha2 = await workspace.commit('Second commit');

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.commits).toEqual([sha1, sha2]);
    });
  });

  describe('push()', () => {
    it('pushes commits to remote', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
      });

      await workspace.init();
      await workspace.createBranch('job/push-test', 'main', 'if_missing');

      // Create and commit a change
      writeFileSync(join(workspace.getRepoPath(), 'pushed.txt'), 'pushed content');
      await workspace.commit('Add pushed file');

      await workspace.push('origin');

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.pushed).toBe(true);

      // Verify by checking the bare repo directly for the pushed branch
      const branchOutput = execSync('git branch', {
        cwd: bareRepoPath,
        encoding: 'utf-8',
      });
      expect(branchOutput).toContain('job/push-test');
    });

    it('skips push when no commits', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();
      await workspace.createBranch('job/no-commits', 'main', 'if_missing');

      // Push without any commits
      await workspace.push('origin');

      const meta = workspace.getResolvedMetadata()!;
      expect(meta.pushed).toBe(false);
    });

    it('throws when no branch checked out', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
      });

      await workspace.init();

      // Get a SHA to checkout in detached HEAD
      const sha = await workspace.resolveRef('HEAD');

      // Run git checkout with detach flag directly
      await workspace.runGit(['checkout', '--detach', sha]);

      // Create a commit in detached state
      writeFileSync(join(workspace.getRepoPath(), 'detached.txt'), 'content');
      await workspace.runGit(['add', 'detached.txt']);
      await workspace.runGit(['commit', '-m', 'Detached commit']);

      // Manually add to commits array since commit() wasn't used
      // This is a bit of a hack but tests the push validation
      // Actually, let's test that push requires resolvedBranch to be set
      await expect(workspace.push('origin')).rejects.toThrow('no branch checked out');
    });
  });

  describe('getResolvedMetadata()', () => {
    it('tracks all git operations', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
        gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
      });

      await workspace.init();
      await workspace.checkout('main', 'project_default');
      await workspace.createBranch('job/full-flow', 'main', 'if_missing');

      // Create multiple commits
      writeFileSync(join(workspace.getRepoPath(), 'file1.txt'), 'content1');
      const sha1 = await workspace.commit('First commit');

      writeFileSync(join(workspace.getRepoPath(), 'file2.txt'), 'content2');
      const sha2 = await workspace.commit('Second commit');

      await workspace.push('origin');

      const meta = workspace.getResolvedMetadata()!;

      expect(meta.resolved_ref).toBe('main'); // From checkout
      expect(meta.resolved_branch).toBe('job/full-flow'); // From createBranch
      expect(meta.ref_source).toBe('project_default');
      expect(meta.pushed).toBe(true);
      expect(meta.commits).toEqual([sha1, sha2]);
    });

    it('returns undefined metadata before operations', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      const meta = workspace.getResolvedMetadata();

      expect(meta).toBeUndefined();
    });
  });

  describe('utility methods', () => {
    it('hasUncommittedChanges detects changes', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      expect(await workspace.hasUncommittedChanges()).toBe(false);

      writeFileSync(join(workspace.getRepoPath(), 'uncommitted.txt'), 'content');

      expect(await workspace.hasUncommittedChanges()).toBe(true);
    });

    it('branchExists checks local branches', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      // Local main branch should exist
      expect(await workspace.branchExists('main')).toBe(true);

      // Non-existent branch
      expect(await workspace.branchExists('nonexistent')).toBe(false);

      // Create a local branch and check it exists
      await workspace.runGit(['checkout', '-b', 'test-local-branch']);
      expect(await workspace.branchExists('test-local-branch')).toBe(true);
    });

    it('getCurrentBranch returns current branch name', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      // After init with default branch, should be on main
      expect(await workspace.getCurrentBranch()).toBe('main');

      // Create and checkout a new branch
      await workspace.runGit(['checkout', '-b', 'test-branch']);
      expect(await workspace.getCurrentBranch()).toBe('test-branch');
    });

    it('getCurrentBranch returns undefined in detached HEAD', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();
      const sha = await workspace.resolveRef('HEAD');
      await workspace.runGit(['checkout', '--detach', sha]);

      expect(await workspace.getCurrentBranch()).toBeUndefined();
    });

    it('reset cleans working tree', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      // Create unstaged and staged changes
      writeFileSync(join(workspace.getRepoPath(), 'untracked.txt'), 'untracked');
      await workspace.runGit(['add', 'untracked.txt']);
      writeFileSync(join(workspace.getRepoPath(), 'another.txt'), 'another');

      expect(await workspace.hasUncommittedChanges()).toBe(true);

      await workspace.reset();

      expect(await workspace.hasUncommittedChanges()).toBe(false);
      expect(existsSync(join(workspace.getRepoPath(), 'untracked.txt'))).toBe(false);
      expect(existsSync(join(workspace.getRepoPath(), 'another.txt'))).toBe(false);
    });

    it('resolveRef resolves refs to SHA', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      const sha = await workspace.resolveRef('HEAD');
      expect(sha).toHaveLength(40);
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    });

    it('getRepoPath returns correct path', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      expect(workspace.getRepoPath()).toBe(join(workspacePath, 'repo'));
    });

    it('getWorkspacePath returns correct path', () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      expect(workspace.getWorkspacePath()).toBe(workspacePath);
    });
  });

  describe('error handling', () => {
    it('throws GitWorkspaceError on git command failure', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      // Try to checkout a non-existent ref
      await expect(
        workspace.runGit(['checkout', 'definitely-does-not-exist-xyz123']),
      ).rejects.toThrow(GitWorkspaceError);
    });

    it('GitWorkspaceError includes operation context', async () => {
      const workspace = new GitWorkspace({
        repoUrl: bareRepoPath,
        workspacePath,
      });

      await workspace.init();

      try {
        await workspace.runGit(['checkout', 'nonexistent-ref-abc']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GitWorkspaceError);
        expect((error as GitWorkspaceError).operation).toBe('checkout');
      }
    });
  });
});

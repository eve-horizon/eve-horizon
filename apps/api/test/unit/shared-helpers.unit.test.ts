import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatAttemptId,
  formatJobId,
  generateOrgId,
  generateProjectId,
  generateSecretId,
  parseAttemptId,
  parseJobId,
  listHarnessConfigVariants,
  resolveHarnessConfig,
  resolveHarnessConfigRoot,
  resolveClaudeConfigDir,
  resolveCodeConfigDir,
} from '@eve/shared';

describe('shared helpers: ids', () => {
  it('formats and parses job ids', () => {
    const jobId = formatJobId('proj_abc123', 42);
    expect(jobId).toBe('proj_abc123:42');
    expect(parseJobId(jobId)).toEqual({ projectId: 'proj_abc123', jobNumber: 42 });
    expect(parseJobId('invalid')).toBeNull();
  });

  it('formats and parses attempt ids', () => {
    const attemptId = formatAttemptId('proj_abc123', 42, 3);
    expect(attemptId).toBe('proj_abc123:42:3');
    expect(parseAttemptId(attemptId)).toEqual({
      projectId: 'proj_abc123',
      jobNumber: 42,
      attemptNumber: 3,
    });
    expect(parseAttemptId('proj_abc123:bad')).toBeNull();
  });

  it('generates typeid-based org/project/secret ids', () => {
    expect(generateOrgId()).toMatch(/^org_/);
    expect(generateProjectId()).toMatch(/^proj_/);
    expect(generateSecretId()).toMatch(/^secr_/);
  });
});

describe('shared helpers: harness config resolution', () => {
  it('prefers EVE_HARNESS_CONFIG_ROOT when set', () => {
    const root = resolveHarnessConfigRoot({
      harness: 'mclaude',
      env: { EVE_HARNESS_CONFIG_ROOT: '/tmp/harnesses' },
    });

    expect(root).toEqual({
      root: path.join('/tmp/harnesses', 'mclaude'),
      source: 'env',
    });
  });

  it('falls back to repo path when provided', () => {
    const root = resolveHarnessConfigRoot({
      harness: 'mclaude',
      repoPath: '/repo',
    });

    expect(root).toEqual({
      root: path.join('/repo', '.agent', 'harnesses', 'mclaude'),
      source: 'repo',
    });
  });

  it('resolves variants when present', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-harness-'));
    const root = path.join(tempRoot, '.agent', 'harnesses', 'code');
    const variantDir = path.join(root, 'variants', 'fast');
    fs.mkdirSync(variantDir, { recursive: true });

    const result = resolveHarnessConfig({
      harness: 'code',
      variant: 'fast',
      repoPath: tempRoot,
    });

    expect(result).toEqual({
      configDir: variantDir,
      baseDir: root,
      hasVariant: true,
      source: 'repo',
    });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to base dir when variant missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-harness-missing-'));
    const root = path.join(tempRoot, '.agent', 'harnesses', 'code');
    fs.mkdirSync(root, { recursive: true });

    const result = resolveHarnessConfig({
      harness: 'code',
      variant: 'missing',
      repoPath: tempRoot,
    });

    expect(result).toEqual({
      configDir: root,
      baseDir: root,
      hasVariant: false,
      source: 'repo',
    });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lists harness variants in sorted order', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-harness-variants-'));
    const variantsRoot = path.join(tempRoot, '.agent', 'harnesses', 'mclaude', 'variants');
    fs.mkdirSync(path.join(variantsRoot, 'fast'), { recursive: true });
    fs.mkdirSync(path.join(variantsRoot, 'plan'), { recursive: true });
    fs.mkdirSync(path.join(variantsRoot, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(variantsRoot, 'readme.txt'), 'ignore');

    const variants = listHarnessConfigVariants({ harness: 'mclaude', repoPath: tempRoot });
    expect(variants).toEqual(['fast', 'plan']);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves Claude and Code config dirs with overrides', () => {
    const claude = resolveClaudeConfigDir('mclaude', 'fast', {
      env: { CLAUDE_CONFIG_DIR: '/opt/claude' },
    });
    expect(claude).toBe(path.join('/opt/claude', 'variants', 'fast'));

    const code = resolveCodeConfigDir('codex', 'plan', {
      env: { CODEX_HOME: '/opt/codex/variants/plan' },
    });
    expect(code).toBe('/opt/codex/variants/plan');
  });
});

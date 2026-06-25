import { describe, it, expect } from 'vitest';
import { GitShaSchema, DeployRequestSchema, CreateBuildSpecRequestSchema, PipelineRunRequestSchema } from '../index.js';

describe('GitShaSchema validation', () => {
  describe('valid git SHAs', () => {
    it('should accept valid 40-char lowercase hex SHA', () => {
      const validSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const result = GitShaSchema.safeParse(validSha);
      expect(result.success).toBe(true);
    });

    it('should accept SHA with all zeros', () => {
      const validSha = '0000000000000000000000000000000000000000';
      const result = GitShaSchema.safeParse(validSha);
      expect(result.success).toBe(true);
    });

    it('should accept SHA with all f characters', () => {
      const validSha = 'ffffffffffffffffffffffffffffffffffffffff';
      const result = GitShaSchema.safeParse(validSha);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid git SHAs', () => {
    it('should reject branch names', () => {
      const branchName = 'main';
      const result = GitShaSchema.safeParse(branchName);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('exactly 40 characters');
      }
    });

    it('should reject short SHAs', () => {
      const shortSha = 'a1b2c3d';
      const result = GitShaSchema.safeParse(shortSha);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('exactly 40 characters');
      }
    });

    it('should reject uppercase hex characters', () => {
      const uppercaseSha = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2';
      const result = GitShaSchema.safeParse(uppercaseSha);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('lowercase hex SHA');
      }
    });

    it('should reject mixed case hex characters', () => {
      const mixedCaseSha = 'a1b2c3d4e5f6A1B2C3D4e5f6a1b2c3d4e5f6a1b2';
      const result = GitShaSchema.safeParse(mixedCaseSha);
      expect(result.success).toBe(false);
    });

    it('should reject non-hex characters', () => {
      const invalidSha = 'g1h2i3j4k5l6m1n2o3p4q5r6s1t2u3v4w5x6y1z2';
      const result = GitShaSchema.safeParse(invalidSha);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('lowercase hex SHA');
      }
    });

    it('should reject SHA with special characters', () => {
      const invalidSha = 'a1b2c3d4-e5f6-a1b2-c3d4-e5f6a1b2c3d4e5f6';
      const result = GitShaSchema.safeParse(invalidSha);
      expect(result.success).toBe(false);
    });

    it('should reject empty string', () => {
      const emptySha = '';
      const result = GitShaSchema.safeParse(emptySha);
      expect(result.success).toBe(false);
    });

    it('should reject SHA that is too long', () => {
      const longSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2extra';
      const result = GitShaSchema.safeParse(longSha);
      expect(result.success).toBe(false);
    });
  });
});

describe('DeployRequestSchema with git_sha validation', () => {
  it('should accept valid deploy request with git_sha', () => {
    const validRequest = {
      git_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      manifest_hash: 'abc123',
    };
    const result = DeployRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it('should reject deploy request with branch name as git_sha', () => {
    const invalidRequest = {
      git_sha: 'main',
      manifest_hash: 'abc123',
    };
    const result = DeployRequestSchema.safeParse(invalidRequest);
    expect(result.success).toBe(false);
  });

  it('should accept deploy request with release_tag (no git_sha)', () => {
    const validRequest = {
      release_tag: 'v1.0.0',
    };
    const result = DeployRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });
});

describe('CreateBuildSpecRequestSchema with git_sha validation', () => {
  it('should accept valid build spec request', () => {
    const validRequest = {
      git_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      manifest_hash: 'abc123',
    };
    const result = CreateBuildSpecRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it('should reject build spec request with branch name as git_sha', () => {
    const invalidRequest = {
      git_sha: 'develop',
      manifest_hash: 'abc123',
    };
    const result = CreateBuildSpecRequestSchema.safeParse(invalidRequest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('exactly 40 characters');
    }
  });

  it('should reject build spec request with short SHA', () => {
    const invalidRequest = {
      git_sha: 'a1b2c3d',
      manifest_hash: 'abc123',
    };
    const result = CreateBuildSpecRequestSchema.safeParse(invalidRequest);
    expect(result.success).toBe(false);
  });
});

describe('PipelineRunRequestSchema with ref validation', () => {
  it('should accept valid pipeline run request', () => {
    const validRequest = {
      ref: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };
    const result = PipelineRunRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it('should reject pipeline run request with branch name as ref', () => {
    const invalidRequest = {
      ref: 'feature/new-feature',
    };
    const result = PipelineRunRequestSchema.safeParse(invalidRequest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('exactly 40 characters');
    }
  });

  it('should reject pipeline run request with tag as ref', () => {
    const invalidRequest = {
      ref: 'v1.0.0',
    };
    const result = PipelineRunRequestSchema.safeParse(invalidRequest);
    expect(result.success).toBe(false);
  });
});

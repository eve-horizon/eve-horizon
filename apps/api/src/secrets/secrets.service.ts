import { Injectable, Inject, Logger, BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Db } from '@eve/db';
import { secretQueries, projectQueries, orgQueries, projectManifestQueries, type SecretScopeType, type SecretType } from '@eve/db';
import { ManifestSchema, getManifestRequiredSecrets, generateSecretId, findClosestMatches, type CreateSecretRequest, type SecretListResponse, type SecretMaskedResponse, type SecretResponse, type SecretValidationResult, type UpdateSecretRequest, loadConfig } from '@eve/shared';
import * as yaml from 'yaml';

const MASK_VISIBLE_CHARS = 4;
const SAFE_SECRET_ALLOWLIST = new Set(['GITHUB_WEBHOOK_SECRET']);

@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private secrets: ReturnType<typeof secretQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private masterKey: Buffer | null;

  constructor(@Inject('DB') private readonly db: Db) {
    this.secrets = secretQueries(this.db);
    this.projects = projectQueries(this.db);
    this.orgs = orgQueries(this.db);
    this.manifests = projectManifestQueries(this.db);
    const config = loadConfig();
    this.masterKey = config.EVE_SECRETS_MASTER_KEY
      ? createHash('sha256').update(config.EVE_SECRETS_MASTER_KEY).digest()
      : null;
  }

  async create(scopeType: SecretScopeType, scopeId: string, data: CreateSecretRequest): Promise<SecretResponse> {
    this.ensureConfigured();
    await this.ensureScopeExists(scopeType, scopeId);
    const encrypted = this.encrypt(data.value);
    const existing = await this.secrets.findByScopeAndKey(scopeType, scopeId, data.key);
    if (existing) {
      const updated = await this.secrets.updateByKey(scopeType, scopeId, data.key, {
        value_encrypted: encrypted,
        type: data.type ?? existing.type,
      });
      if (!updated) {
        throw new NotFoundException(`Secret ${data.key} not found`);
      }
      return this.toResponse(updated);
    }

    const id = generateSecretId();
    const secret = await this.secrets.create({
      id,
      scope_type: scopeType,
      scope_id: scopeId,
      key: data.key,
      type: data.type ?? 'env_var',
      value_encrypted: encrypted,
    });
    return this.toResponse(secret);
  }

  async list(
    scopeType: SecretScopeType,
    scopeId: string,
    options: { limit: number; offset: number },
  ): Promise<SecretListResponse> {
    await this.ensureScopeExists(scopeType, scopeId);
    const secrets = await this.secrets.listByScope(scopeType, scopeId, options);
    return {
      data: secrets.map((secret) => this.toResponse(secret)),
      pagination: {
        limit: options.limit,
        offset: options.offset,
        count: secrets.length,
      },
    };
  }

  async showMasked(scopeType: SecretScopeType, scopeId: string, key: string): Promise<SecretMaskedResponse> {
    this.ensureConfigured();
    await this.ensureScopeExists(scopeType, scopeId);
    const secret = await this.secrets.findByScopeAndKey(scopeType, scopeId, key);
    if (!secret) {
      throw new NotFoundException(`Secret ${key} not found`);
    }
    const decrypted = this.decrypt(secret.value_encrypted);
    return {
      ...this.toResponse(secret),
      masked_value: maskSecretValue(decrypted),
    };
  }

  async update(
    scopeType: SecretScopeType,
    scopeId: string,
    key: string,
    updates: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    this.ensureConfigured();
    await this.ensureScopeExists(scopeType, scopeId);
    if (!updates.value && !updates.type) {
      throw new BadRequestException('No updates provided');
    }
    const encrypted = updates.value ? this.encrypt(updates.value) : undefined;
    const updated = await this.secrets.updateByKey(scopeType, scopeId, key, {
      value_encrypted: encrypted,
      type: updates.type,
    });
    if (!updated) {
      throw new NotFoundException(`Secret ${key} not found`);
    }
    return this.toResponse(updated);
  }

  /**
   * Update a secret value only if it already exists. Returns true if updated, false if not found.
   * Used by the internal write-back endpoint — never creates new secrets.
   */
  async updateIfExists(scopeType: 'user' | 'org' | 'project' | 'system', scopeId: string, key: string, value: string): Promise<boolean> {
    this.ensureConfigured();
    const encrypted = this.encrypt(value);
    const updated = await this.secrets.updateByKey(scopeType as SecretScopeType, scopeId, key, { value_encrypted: encrypted });
    return updated !== null && updated !== undefined;
  }

  async delete(scopeType: SecretScopeType, scopeId: string, key: string): Promise<void> {
    await this.ensureScopeExists(scopeType, scopeId);
    const deleted = await this.secrets.deleteByKey(scopeType, scopeId, key);
    if (!deleted) {
      throw new NotFoundException(`Secret ${key} not found`);
    }
  }

  /**
   * Bootstrap system secrets from system-secrets.env.local file.
   * Loads KEY=VALUE pairs and upserts them into the secrets table with scope_type='system' and scope_id='system'.
   * @returns Number of secrets loaded
   */
  async loadSystemSecrets(): Promise<number> {
    this.ensureConfigured();

    // Determine project root (go up from apps/api)
    const projectRoot = join(__dirname, '..', '..', '..', '..');
    const systemSecretsPath = join(projectRoot, 'system-secrets.env.local');

    let fileContent: string;
    try {
      fileContent = readFileSync(systemSecretsPath, 'utf-8');
    } catch (error) {
      // File doesn't exist, return 0
      return 0;
    }

    const lines = fileContent.split('\n');
    let loadedCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse KEY=VALUE
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) {
        continue; // Skip malformed lines
      }

      const key = trimmed.slice(0, equalIndex).trim();
      const value = trimmed.slice(equalIndex + 1).trim();

      if (!key) {
        continue; // Skip if key is empty
      }

      // Upsert the secret (create will update if exists)
      await this.create('system', 'system', {
        key,
        value,
        type: 'env_var',
      });

      loadedCount++;
    }

    console.log(`Loaded ${loadedCount} system secrets from ${systemSecretsPath}`);
    return loadedCount;
  }

  async resolveForOrg(orgId: string): Promise<Array<{ key: string; value: string; type: SecretType }>> {
    this.ensureConfigured();
    await this.ensureScopeExists('org', orgId);

    const resolved = new Map<string, { value: string; type: SecretType; scope_type: 'user' | 'org' | 'project' | 'system'; scope_id: string }>();

    // Resolution order: system → org (org wins)

    // 1. Load system secrets
    const systemSecrets = await this.secrets.listByScope('system', 'system', { limit: 500, offset: 0 });
    this.decryptSecrets(systemSecrets, resolved, 'system', 'system');

    // 2. Layer org secrets on top (org overrides system)
    const orgSecrets = await this.secrets.listByScope('org', orgId, { limit: 500, offset: 0 });
    this.decryptSecrets(orgSecrets, resolved, 'org', orgId);

    return Array.from(resolved.entries()).map(([key, entry]) => ({
      key,
      value: entry.value,
      type: entry.type,
    }));
  }

  async resolveForProject(projectId: string, userId?: string): Promise<Array<{ key: string; value: string; type: SecretType; scope_type: 'user' | 'org' | 'project' | 'system'; scope_id: string }>> {
    this.ensureConfigured();
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const orgId = project.org_id;

    const resolved = new Map<string, { value: string; type: SecretType; scope_type: 'user' | 'org' | 'project' | 'system'; scope_id: string }>();

    // Resolution order: system → org → user → project (project wins)

    // 1. Load system secrets (overrides host env)
    const systemSecrets = await this.secrets.listByScope('system', 'system', { limit: 500, offset: 0 });
    this.decryptSecrets(systemSecrets, resolved, 'system', 'system');

    // 2. Layer org secrets on top (org overrides system)
    const orgSecrets = await this.secrets.listByScope('org', orgId, { limit: 500, offset: 0 });
    this.decryptSecrets(orgSecrets, resolved, 'org', orgId);

    // 3. Layer user secrets on top (user overrides org)
    if (userId) {
      const userSecrets = await this.secrets.listByScope('user', userId, { limit: 500, offset: 0 });
      this.decryptSecrets(userSecrets, resolved, 'user', userId);
    }

    // 4. Layer project secrets on top (highest priority, project wins)
    const projectSecrets = await this.secrets.listByScope('project', projectId, { limit: 500, offset: 0 });
    this.decryptSecrets(projectSecrets, resolved, 'project', projectId);

    return Array.from(resolved.entries()).map(([key, entry]) => ({
      key,
      value: entry.value,
      type: entry.type,
      scope_type: entry.scope_type,
      scope_id: entry.scope_id,
    }));
  }

  async validateRequiredSecrets(projectId: string, requiredKeys: string[], userId?: string): Promise<SecretValidationResult> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const required = Array.from(new Set(requiredKeys.filter((key) => key && typeof key === 'string')));
    if (required.length === 0) {
      return { missing: [] };
    }

    const available = await this.listAvailableSecretKeys(projectId, userId);
    const missing = required.filter((key) => !available.has(key));
    const hints = (key: string): string[] => [
      `eve secrets set ${key} <value> --project ${projectId}`,
      `eve secrets set ${key} <value> --org ${project.org_id}`,
      'eve secrets set ' + key + ' <value> --system',
    ];

    return {
      missing: missing.map((key) => {
        const closest = findClosestMatches(key, available, 2);
        const suggestion = closest.length > 0 ? `Did you mean "${closest[0]}"?` : undefined;
        return { key, hints: hints(key), suggestion };
      }),
    };
  }

  async validateManifestSecrets(projectId: string, manifestYaml: string): Promise<SecretValidationResult> {
    const parsed = yaml.parse(manifestYaml);
    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new BadRequestException(`Invalid YAML: ${validated.error.message}`);
    }
    const required = getManifestRequiredSecrets(validated.data);
    return this.validateRequiredSecrets(projectId, required);
  }

  async validateLatestManifestSecrets(projectId: string): Promise<SecretValidationResult> {
    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      throw new BadRequestException(`No manifest found for project ${projectId}`);
    }
    return this.validateManifestSecrets(projectId, manifest.manifest_yaml);
  }

  async resolveProjectSecretValue(projectId: string, key: string): Promise<string | null> {
    if (!this.masterKey) {
      return null;
    }
    await this.ensureScopeExists('project', projectId);
    const secret = await this.secrets.findByScopeAndKey('project', projectId, key);
    if (!secret) {
      return null;
    }
    return this.decrypt(secret.value_encrypted);
  }

  async ensureSafeSecrets(projectId: string, keys: string[]): Promise<{ created: string[]; existing: string[] }> {
    this.ensureConfigured();
    await this.ensureScopeExists('project', projectId);

    const unique = Array.from(new Set(keys));
    for (const key of unique) {
      if (!SAFE_SECRET_ALLOWLIST.has(key)) {
        throw new BadRequestException(`Secret ${key} is not allowed for ensure/export`);
      }
    }

    const created: string[] = [];
    const existing: string[] = [];

    for (const key of unique) {
      const current = await this.secrets.findByScopeAndKey('project', projectId, key);
      if (current) {
        existing.push(key);
        continue;
      }
      const value = randomBytes(32).toString('base64url');
      await this.create('project', projectId, { key, value, type: 'env_var' });
      created.push(key);
    }

    return { created, existing };
  }

  async exportSafeSecrets(projectId: string, keys: string[]): Promise<Array<{ key: string; value: string }>> {
    this.ensureConfigured();
    await this.ensureScopeExists('project', projectId);

    const unique = Array.from(new Set(keys));
    for (const key of unique) {
      if (!SAFE_SECRET_ALLOWLIST.has(key)) {
        throw new BadRequestException(`Secret ${key} is not allowed for export`);
      }
    }

    const exports: Array<{ key: string; value: string }> = [];
    for (const key of unique) {
      const secret = await this.secrets.findByScopeAndKey('project', projectId, key);
      if (!secret) {
        throw new NotFoundException(`Secret ${key} not found`);
      }
      exports.push({ key, value: this.decrypt(secret.value_encrypted) });
    }

    return exports;
  }

  private toResponse(secret: { id: string; scope_type: SecretScopeType; scope_id: string; key: string; type: SecretType; created_at: Date; updated_at: Date }): SecretResponse {
    return {
      id: secret.id,
      scope_type: secret.scope_type,
      scope_id: secret.scope_id,
      key: secret.key,
      type: secret.type,
      created_at: secret.created_at.toISOString(),
      updated_at: secret.updated_at.toISOString(),
    };
  }

  /**
   * Decrypt secrets into the resolved map, skipping any that fail decryption
   * (e.g. encrypted with a rotated master key). This prevents a single stale
   * secret from crashing the entire resolution pipeline.
   */
  private decryptSecrets(
    secrets: Array<{ key: string; value_encrypted: string; type: SecretType }>,
    resolved: Map<string, { value: string; type: SecretType; scope_type: 'user' | 'org' | 'project' | 'system'; scope_id: string }>,
    scope: 'user' | 'org' | 'project' | 'system',
    scopeId: string,
  ): void {
    for (const secret of secrets) {
      try {
        resolved.set(secret.key, { value: this.decrypt(secret.value_encrypted), type: secret.type, scope_type: scope, scope_id: scopeId });
      } catch (err) {
        this.logger.warn(
          `Failed to decrypt ${scope} secret "${secret.key}" — skipping (likely encrypted with a previous master key). ` +
          `Re-set this secret to re-encrypt it: eve secrets set ${secret.key} <value> --${scope === 'system' ? 'system' : scope} <id>`,
        );
      }
    }
  }

  private ensureConfigured(): void {
    if (!this.masterKey) {
      throw new InternalServerErrorException('Secrets master key is required to use secrets');
    }
  }

  private async ensureScopeExists(scopeType: SecretScopeType, scopeId: string): Promise<void> {
    // System scope always exists
    if (scopeType === 'system') {
      return;
    }
    if (scopeType === 'org') {
      const org = await this.orgs.findById(scopeId, { include_deleted: false });
      if (!org) {
        throw new NotFoundException(`Organization ${scopeId} not found`);
      }
    }
    if (scopeType === 'project') {
      const project = await this.projects.findById(scopeId, { include_deleted: false });
      if (!project) {
        throw new NotFoundException(`Project ${scopeId} not found`);
      }
    }
  }

  private async listAvailableSecretKeys(projectId: string, userId?: string): Promise<Set<string>> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const keys = new Set<string>();

    const systemSecrets = await this.secrets.listByScope('system', 'system', { limit: 500, offset: 0 });
    for (const secret of systemSecrets) {
      keys.add(secret.key);
    }

    const orgSecrets = await this.secrets.listByScope('org', project.org_id, { limit: 500, offset: 0 });
    for (const secret of orgSecrets) {
      keys.add(secret.key);
    }

    if (userId) {
      const userSecrets = await this.secrets.listByScope('user', userId, { limit: 500, offset: 0 });
      for (const secret of userSecrets) {
        keys.add(secret.key);
      }
    }

    const projectSecrets = await this.secrets.listByScope('project', projectId, { limit: 500, offset: 0 });
    for (const secret of projectSecrets) {
      keys.add(secret.key);
    }

    return keys;
  }

  private encrypt(value: string): string {
    if (!this.masterKey) {
      throw new InternalServerErrorException('Secrets master key not configured');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  private decrypt(payload: string): string {
    if (!this.masterKey) {
      throw new InternalServerErrorException('Secrets master key not configured');
    }
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
      throw new BadRequestException('Invalid secret payload');
    }
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

export function maskSecretValue(value: string): string {
  if (!value) return '';
  if (value.length <= 2) {
    return '*'.repeat(value.length);
  }
  if (value.length <= MASK_VISIBLE_CHARS * 2) {
    const first = value.slice(0, 1);
    const last = value.slice(-1);
    return `${first}${'*'.repeat(value.length - 2)}${last}`;
  }
  const first = value.slice(0, MASK_VISIBLE_CHARS);
  const last = value.slice(-MASK_VISIBLE_CHARS);
  return `${first}${'*'.repeat(value.length - MASK_VISIBLE_CHARS * 2)}${last}`;
}

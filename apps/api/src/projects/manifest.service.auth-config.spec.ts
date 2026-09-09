import { describe, expect, it } from 'vitest';
import { ProjectAuthConfigSchema, type ProjectAuthConfig } from '@eve/shared';
import { ManifestService } from './manifest.service';

type StoredAuthConfig = Omit<ProjectAuthConfig, 'oauth_providers'> & {
  oauth_providers?: ProjectAuthConfig['oauth_providers'];
};

function normalize(auth: ProjectAuthConfig): Promise<StoredAuthConfig | null> {
  const service = new ManifestService({} as never, {} as never);
  return (service as unknown as {
    normalizeProjectAuthConfig(projectOrgId: string, authConfig: ProjectAuthConfig): Promise<StoredAuthConfig | null>;
  }).normalizeProjectAuthConfig('org_project', auth);
}

describe('ManifestService auth config storage normalization', () => {
  it.each([
    ['absent', {}],
    ['default', { oauth_providers: undefined }],
    ['explicit empty', { oauth_providers: [] }],
  ])('omits %s OAuth providers while preserving the other policy values', async (_name, input) => {
    const auth = ProjectAuthConfigSchema.parse({
      login_method: 'magic_link',
      self_signup: false,
      invite_requires_password: false,
      ...input,
    });

    const stored = await normalize(auth);

    expect(stored).toEqual(expect.objectContaining({
      login_method: 'magic_link',
      self_signup: false,
      invite_requires_password: false,
      org_access: expect.objectContaining({
        mode: 'project_org',
        allowed_orgs: ['org_project'],
      }),
    }));
    expect(stored).not.toHaveProperty('oauth_providers');
  });

  it('persists an explicit Google opt-in', async () => {
    const stored = await normalize(ProjectAuthConfigSchema.parse({
      login_method: 'password',
      self_signup: false,
      invite_requires_password: true,
      oauth_providers: ['google'],
    }));

    expect(stored).toEqual(expect.objectContaining({
      login_method: 'password',
      self_signup: false,
      invite_requires_password: true,
      oauth_providers: ['google'],
      org_access: expect.objectContaining({ allowed_orgs: ['org_project'] }),
    }));
  });
});

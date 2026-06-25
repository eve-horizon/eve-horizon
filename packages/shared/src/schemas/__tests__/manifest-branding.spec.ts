import { describe, expect, it } from 'vitest';
import {
  ManifestSchema,
  ProjectAuthConfigSchema,
  ProjectBrandingSchema,
  getManifestAuthConfig,
  getManifestBranding,
} from '../manifest.js';

describe('ProjectBrandingSchema', () => {
  it('accepts and trims the documented branding block', () => {
    const parsed = ProjectBrandingSchema.parse({
      app_name: ' ACME Portal ',
      app_logo_url: ' https://sandbox.acme.example/assets/logo.svg ',
      primary_color: ' #1f6feb ',
      email_from_name: ' ACME Portal ',
      reply_to_email: ' support@acme.example ',
      support_email: ' support@acme.example ',
      support_url: ' https://acme.example/help ',
    });

    expect(parsed).toEqual({
      app_name: 'ACME Portal',
      app_logo_url: 'https://sandbox.acme.example/assets/logo.svg',
      primary_color: '#1f6feb',
      email_from_name: 'ACME Portal',
      reply_to_email: 'support@acme.example',
      support_email: 'support@acme.example',
      support_url: 'https://acme.example/help',
    });
  });

  it('rejects invalid colors, URLs, and header newlines', () => {
    expect(ProjectBrandingSchema.safeParse({
      app_name: 'ACME Portal',
      primary_color: 'blue',
    }).success).toBe(false);

    expect(ProjectBrandingSchema.safeParse({
      app_name: 'ACME Portal',
      app_logo_url: 'not-a-url',
    }).success).toBe(false);

    expect(ProjectBrandingSchema.safeParse({
      app_name: 'ACME Portal\r\nBcc: attacker@example.com',
    }).success).toBe(false);
  });
});

describe('ProjectAuthConfigSchema', () => {
  it('accepts the documented passwordless auth block', () => {
    const parsed = ProjectAuthConfigSchema.parse({
      login_method: 'magic_link',
      self_signup: false,
      invite_requires_password: false,
    });

    expect(parsed).toEqual({
      login_method: 'magic_link',
      self_signup: false,
      invite_requires_password: false,
      org_access: {
        mode: 'project_org',
        allowed_orgs: [],
        invite: {
          enabled: false,
          admin_roles: ['admin', 'owner'],
          invited_role: 'member',
        },
        domain_signup: {
          enabled: false,
          domains: [],
        },
      },
      allowed_redirect_origins: [],
    });
  });

  it('applies conservative defaults', () => {
    const parsed = ProjectAuthConfigSchema.parse({});

    expect(parsed).toEqual({
      login_method: 'password_or_magic_link',
      self_signup: false,
      invite_requires_password: true,
      org_access: {
        mode: 'project_org',
        allowed_orgs: [],
        invite: {
          enabled: false,
          admin_roles: ['admin', 'owner'],
          invited_role: 'member',
        },
        domain_signup: {
          enabled: false,
          domains: [],
        },
      },
      allowed_redirect_origins: [],
    });
  });

  it('rejects invalid login methods', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      login_method: 'webauthn',
    }).success).toBe(false);
  });

  it('accepts app org access and invite policy', () => {
    const parsed = ProjectAuthConfigSchema.parse({
      login_method: 'magic_link',
      self_signup: false,
      invite_requires_password: false,
      org_access: {
        mode: 'allowlist',
        allowed_orgs: ['tenant-a', 'org_tenantb'],
        invite: {
          enabled: true,
        },
      },
    });

    expect(parsed.org_access).toEqual({
      mode: 'allowlist',
      allowed_orgs: ['tenant-a', 'org_tenantb'],
      invite: {
        enabled: true,
        admin_roles: ['admin', 'owner'],
        invited_role: 'member',
      },
      domain_signup: {
        enabled: false,
        domains: [],
      },
    });
  });

  it('rejects elevated app invite roles', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      org_access: {
        invite: {
          invited_role: 'admin',
        },
      },
    }).success).toBe(false);
  });

  it('accepts and normalizes allowed_redirect_origins', () => {
    const parsed = ProjectAuthConfigSchema.parse({
      allowed_redirect_origins: [
        'https://sandbox.acme.example',
        'https://sandbox.acme.example/',
        'https://app.example.com:8443',
        'http://web.example.lvh.me',
      ],
    });

    expect(parsed.allowed_redirect_origins).toEqual([
      'https://sandbox.acme.example',
      'https://app.example.com:8443',
      'http://web.example.lvh.me',
    ]);
  });

  it('rejects non-HTTPS origins for non-local hosts', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      allowed_redirect_origins: ['http://attacker.example.com'],
    }).success).toBe(false);
  });

  it('rejects origins with paths, query, or fragment', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      allowed_redirect_origins: ['https://app.example.com/dashboard'],
    }).success).toBe(false);

    expect(ProjectAuthConfigSchema.safeParse({
      allowed_redirect_origins: ['https://app.example.com?foo=bar'],
    }).success).toBe(false);

    expect(ProjectAuthConfigSchema.safeParse({
      allowed_redirect_origins: ['https://app.example.com#section'],
    }).success).toBe(false);
  });

  it('rejects malformed redirect origin URLs', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      allowed_redirect_origins: ['not-a-url'],
    }).success).toBe(false);
  });

  it('rejects origins with userinfo', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      allowed_redirect_origins: ['https://user:pass@example.com'],
    }).success).toBe(false);
  });

  it('accepts v2 domain_signup with per-rule target_org', () => {
    const parsed = ProjectAuthConfigSchema.parse({
      login_method: 'magic_link',
      org_access: {
        mode: 'allowlist',
        allowed_orgs: ['org_acme', 'org_partner'],
        domain_signup: {
          enabled: true,
          domains: [
            { domain: ' Acme.COM ', target_org: 'org_acme' },
            { domain: '*.acme.com', target_org: 'org_acme', role: 'member' },
            { domain: 'partner.example', target_org: 'org_partner' },
          ],
        },
      },
    });
    expect(parsed.org_access.domain_signup).toEqual({
      enabled: true,
      domains: [
        { domain: 'acme.com', target_org: 'org_acme', role: 'member' },
        { domain: '*.acme.com', target_org: 'org_acme', role: 'member' },
        { domain: 'partner.example', target_org: 'org_partner', role: 'member' },
      ],
    });
  });

  it('punycodes IDN domain rules', () => {
    const parsed = ProjectAuthConfigSchema.parse({
      login_method: 'magic_link',
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [{ domain: 'bücher.example', target_org: 'org_target' }],
        },
      },
    });
    expect(parsed.org_access.domain_signup.domains[0].domain).toBe('xn--bcher-kva.example');
  });

  it('rejects domain_signup with enabled=true and no rules', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      org_access: { domain_signup: { enabled: true, domains: [] } },
    }).success).toBe(false);
  });

  it('rejects domain_signup with login_method: password', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      login_method: 'password',
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [{ domain: 'acme.com', target_org: 'org_x' }],
        },
      },
    }).success).toBe(false);
  });

  it('accepts domain_signup with login_method: password_or_magic_link', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      login_method: 'password_or_magic_link',
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [{ domain: 'acme.com', target_org: 'org_x' }],
        },
      },
    }).success).toBe(true);
  });

  it('rejects malformed domain patterns inside a rule', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [{ domain: 'not a domain', target_org: 'org_x' }],
        },
      },
    }).success).toBe(false);

    expect(ProjectAuthConfigSchema.safeParse({
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [{ domain: 'user@acme.com', target_org: 'org_x' }],
        },
      },
    }).success).toBe(false);
  });

  it('rejects rules that omit target_org', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [{ domain: 'acme.com' }],
        },
      },
    }).success).toBe(false);
  });

  it('rejects duplicate domain rules within one block', () => {
    const result = ProjectAuthConfigSchema.safeParse({
      org_access: {
        domain_signup: {
          enabled: true,
          domains: [
            { domain: 'acme.com', target_org: 'org_a' },
            { domain: 'acme.com', target_org: 'org_b' },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('Duplicate domain_signup');
    }
  });

  it('rejects legacy v1 top-level target_org / role', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      org_access: {
        domain_signup: {
          enabled: true,
          target_org: 'org_x',
          domains: [{ domain: 'acme.com', target_org: 'org_x' }],
        },
      },
    }).success).toBe(false);
  });

  it('rejects legacy v1 list-of-strings shape', () => {
    expect(ProjectAuthConfigSchema.safeParse({
      org_access: {
        domain_signup: {
          enabled: true,
          domains: ['acme.com'],
        },
      },
    }).success).toBe(false);
  });
});

describe('getManifestBranding', () => {
  it('reads branding from x-eve', () => {
    const manifest = ManifestSchema.parse({
      'x-eve': {
        branding: {
          app_name: 'ACME Portal',
          primary_color: '#1f6feb',
        },
      },
    });

    expect(getManifestBranding(manifest)).toEqual({
      app_name: 'ACME Portal',
      primary_color: '#1f6feb',
    });
  });

  it('reads branding from x_eve', () => {
    const manifest = ManifestSchema.parse({
      x_eve: {
        branding: {
          app_name: 'Eve Test',
        },
      },
    });

    expect(getManifestBranding(manifest)).toEqual({
      app_name: 'Eve Test',
    });
  });
});

describe('getManifestAuthConfig', () => {
  it('reads auth config from x-eve', () => {
    const manifest = ManifestSchema.parse({
      'x-eve': {
        auth: {
          login_method: 'magic_link',
          self_signup: false,
          invite_requires_password: false,
        },
      },
    });

    expect(getManifestAuthConfig(manifest)).toEqual({
      login_method: 'magic_link',
      self_signup: false,
      invite_requires_password: false,
      org_access: {
        mode: 'project_org',
        allowed_orgs: [],
        invite: {
          enabled: false,
          admin_roles: ['admin', 'owner'],
          invited_role: 'member',
        },
        domain_signup: {
          enabled: false,
          domains: [],
        },
      },
      allowed_redirect_origins: [],
    });
  });

  it('reads auth config from x_eve', () => {
    const manifest = ManifestSchema.parse({
      x_eve: {
        auth: {
          login_method: 'password',
        },
      },
    });

    expect(getManifestAuthConfig(manifest)).toEqual({
      login_method: 'password',
      self_signup: false,
      invite_requires_password: true,
      org_access: {
        mode: 'project_org',
        allowed_orgs: [],
        invite: {
          enabled: false,
          admin_roles: ['admin', 'owner'],
          invited_role: 'member',
        },
        domain_signup: {
          enabled: false,
          domains: [],
        },
      },
      allowed_redirect_origins: [],
    });
  });
});

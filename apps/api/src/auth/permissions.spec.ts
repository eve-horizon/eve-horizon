import { describe, expect, it } from 'vitest';
import { allPermissions, expandPermissions } from './permissions.js';

describe('Permission catalog', () => {
  it('includes orgfs and orgdocs data-plane permissions', () => {
    const permissions = allPermissions();
    expect(permissions).toContain('orgfs:read');
    expect(permissions).toContain('orgfs:write');
    expect(permissions).toContain('orgfs:admin');
    expect(permissions).toContain('orgdocs:read');
    expect(permissions).toContain('orgdocs:write');
    expect(permissions).toContain('orgdocs:admin');
  });

  it('keeps org data-plane permissions out of base member/admin roles (default deny)', () => {
    const member = expandPermissions('member');
    const admin = expandPermissions('admin');

    expect(member.has('orgfs:read')).toBe(false);
    expect(member.has('orgdocs:read')).toBe(false);
    expect(admin.has('orgfs:read')).toBe(false);
    expect(admin.has('orgdocs:read')).toBe(false);
  });
});


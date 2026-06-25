-- Allow system-created org invites (domain_signup policy writes invites with no
-- authenticated admin actor). The original schema required created_by to be a
-- user FK; policy-created invites carry created_by = NULL plus
-- app_context.source = 'domain_signup' so audit trails can still distinguish
-- them from admin-issued invites.
ALTER TABLE org_invites
  ALTER COLUMN created_by DROP NOT NULL;

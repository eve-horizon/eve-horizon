# Security Policy

## Reporting a Vulnerability

Please **do not** open public GitHub issues for security vulnerabilities.

Report them privately via **[GitHub Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
(the "Report a vulnerability" button on the **Security** tab).

Please include a description and impact, steps to reproduce (a proof-of-concept
if available), and the affected versions/components. We aim to acknowledge
reports within **5 business days** and to share a remediation timeline after
triage.

## Why this matters here

Eve Horizon is an agentic platform that handles authentication, RBAC, secrets,
and executes agent workloads. Areas of particular interest:

- Auth / RBAC bypass, privilege escalation, tenant isolation breaks.
- Secret exposure (leaking provider keys, tokens, or one tenant's secrets to another).
- Sandbox or agent-runtime escapes that affect the host or other tenants.
- Manifest / build / deploy paths that could execute untrusted code with elevated rights.

## Scope

This policy covers the `eve-horizon` platform repository. Issues in the
infrastructure template live in `eve-horizon-infra`; SDK issues can be reported
here. Please do not run intrusive tests against any hosted instance without
explicit authorization.

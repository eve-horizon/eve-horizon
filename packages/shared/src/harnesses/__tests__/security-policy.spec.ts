import { describe, it, expect } from 'vitest';
import {
  buildSecurityPolicyPreamble,
  buildSecurityClaudeMd,
  buildProgressUpdateGuidance,
} from '../security-policy.js';

const WORKSPACE = '/workspace/my-repo';

describe('buildSecurityPolicyPreamble', () => {
  it('wraps rules in <security-policy> XML', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toMatch(/^<security-policy>/);
    expect(result).toContain('</security-policy>');
  });

  it('includes a <progress-updates> section after security rules', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toContain('<progress-updates>');
    expect(result).toMatch(/<\/progress-updates>$/);
    expect(result).toContain('eve-message');
  });

  it('includes the workspace path', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toContain(`<workspace>${WORKSPACE}</workspace>`);
  });

  it('includes all five security rules', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    const ruleMatches = result.match(/<rule>/g);
    expect(ruleMatches).toHaveLength(5);
  });

  it('forbids reading files outside the workspace', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toContain('MUST only access files within the workspace');
    expect(result).toContain('MUST NOT use bash commands');
    expect(result).toContain('~/, ~/.config/, /etc/, and /var/');
  });

  it('forbids env var inspection', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toContain('MUST NOT run env, printenv, set, or echo $VAR');
  });

  it('forbids including secrets in output', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toContain('API keys, tokens, passwords, credentials, or secrets');
  });

  it('instructs that CLI tools are pre-configured', () => {
    const result = buildSecurityPolicyPreamble(WORKSPACE);
    expect(result).toContain('pre-configured');
    expect(result).toContain('Do not search for, read, or reference credential files');
  });

  it('embeds the workspace path in the file-access rule', () => {
    const customPath = '/tmp/job-123/repo';
    const result = buildSecurityPolicyPreamble(customPath);
    expect(result).toContain(`MUST only access files within the workspace: ${customPath}`);
  });
});

describe('buildSecurityClaudeMd', () => {
  it('starts with the Security Policy heading', () => {
    const result = buildSecurityClaudeMd(WORKSPACE);
    expect(result).toMatch(/^## Security Policy \(System\)/);
  });

  it('includes the workspace path in backtick-fenced code', () => {
    const result = buildSecurityClaudeMd(WORKSPACE);
    expect(result).toContain(`Workspace path: \`${WORKSPACE}\``);
  });

  it('formats security rules as markdown bullet points', () => {
    const result = buildSecurityClaudeMd(WORKSPACE);
    // Extract only the Security Policy section (before Progress Updates)
    const securitySection = result.split('## Progress Updates')[0];
    const bullets = securitySection.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(5);
  });

  it('contains the same security rules as the XML preamble', () => {
    const xml = buildSecurityPolicyPreamble(WORKSPACE);
    const md = buildSecurityClaudeMd(WORKSPACE);

    // Extract rule text from XML
    const xmlRules = [...xml.matchAll(/<rule>(.*?)<\/rule>/g)].map((m) => m[1]);
    // Extract security rule text from MD (before Progress Updates section)
    const securitySection = md.split('## Progress Updates')[0];
    const mdRules = securitySection.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));

    expect(xmlRules).toEqual(mdRules);
  });

  it('includes a Progress Updates section', () => {
    const result = buildSecurityClaudeMd(WORKSPACE);
    expect(result).toContain('## Progress Updates');
    expect(result).toContain('eve-message');
  });

  it('does not contain XML tags', () => {
    const result = buildSecurityClaudeMd(WORKSPACE);
    expect(result).not.toContain('<security-policy>');
    expect(result).not.toContain('<rule>');
  });
});

describe('buildProgressUpdateGuidance', () => {
  it('describes how to emit eve-message blocks', () => {
    const result = buildProgressUpdateGuidance();
    expect(result).toContain('```eve-message');
    expect(result).toContain('progress updates');
  });

  it('includes do and do-not guidance', () => {
    const result = buildProgressUpdateGuidance();
    expect(result).toContain('Use progress updates for:');
    expect(result).toContain('Do NOT send progress updates for:');
  });
});

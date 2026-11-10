import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type EnvVar = { name: string; value?: string };
type Deployment = {
  spec: { template: { spec: { containers: Array<{ name: string; env?: EnvVar[] }> } } };
};

function gotrueEnv(path: string): Map<string, string | undefined> {
  const manifest = parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Deployment;
  const container = manifest.spec.template.spec.containers.find((c) => c.name === 'gotrue');
  return new Map((container?.env ?? []).map((entry) => [entry.name, entry.value]));
}

describe('GoTrue base manifest', () => {
  it('requires email confirmation for new accounts', () => {
    const env = gotrueEnv('../../../../k8s/base/supabase-auth-deployment.yaml');
    expect(env.get('GOTRUE_MAILER_AUTOCONFIRM')).toBe('false');
  });
});

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('local k8s assets', () => {
  it('mirrors the agent-runtime base manifest', () => {
    expect(readFixture('../../../k8s/base/agent-runtime-deployment.yaml')).toBe(
      readFixture('../assets/local-k8s/base/agent-runtime-deployment.yaml'),
    );
  });

  it('mirrors the agent-runtime local overlay patch', () => {
    expect(readFixture('../../../k8s/overlays/local/agent-runtime-org-id.patch.yaml')).toBe(
      readFixture('../assets/local-k8s/overlays/local/agent-runtime-org-id.patch.yaml'),
    );
  });
});

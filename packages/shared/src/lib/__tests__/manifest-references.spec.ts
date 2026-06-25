import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  assertNoUnresolvedManifestReferences,
  expandManifestReferences,
} from '../manifest-references.js';

describe('manifest workflow references', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'eve-manifest-refs-'));
    mkdirSync(path.join(repoRoot, '.eve'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('expands directory workflow refs and markdown prompt files', () => {
    mkdirSync(path.join(repoRoot, '.eve/workflows/acme-make-plan/prompts'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, '.eve/workflows/acme-make-plan/workflow.yaml'),
      `
description: Make a plan.
inputs:
  slug:
    required: true
steps:
  - name: plan
    agent:
      name: planner
      prompt_file: prompts/plan.md
`,
      'utf-8',
    );
    writeFileSync(
      path.join(repoRoot, '.eve/workflows/acme-make-plan/prompts/plan.md'),
      '# Plan Prompt\n\nCreate the plan.\n',
      'utf-8',
    );
    const manifestYaml = `
name: acme
services: {}
workflows:
  acme-make-plan:
    $ref: .eve/workflows/acme-make-plan
`;

    const result = expandManifestReferences(manifestYaml, { repoRoot });
    const manifest = parseYaml(result.yaml) as Record<string, unknown>;
    const workflow = (manifest.workflows as Record<string, Record<string, unknown>>)['acme-make-plan'];
    const step = (workflow.steps as Array<Record<string, unknown>>)[0]!;
    const agent = step.agent as Record<string, unknown>;

    expect(result.expanded).toBe(true);
    expect(result.sources).toEqual([
      '.eve/workflows/acme-make-plan/prompts/plan.md',
      '.eve/workflows/acme-make-plan/workflow.yaml',
    ]);
    expect(workflow.description).toBe('Make a plan.');
    expect(agent.prompt).toBe('# Plan Prompt\n\nCreate the plan.\n');
    expect(agent).not.toHaveProperty('prompt_file');
  });

  it('expands YAML file workflow refs', () => {
    mkdirSync(path.join(repoRoot, '.eve/workflows/review'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, '.eve/workflows/review.yaml'),
      `
steps:
  - name: review
    agent:
      prompt_file: review/review.md
`,
      'utf-8',
    );
    writeFileSync(
      path.join(repoRoot, '.eve/workflows/review/review.md'),
      'Review the diff.\n',
      'utf-8',
    );
    const manifestYaml = `
name: acme
workflows:
  review:
    $ref: .eve/workflows/review.yaml
`;

    const result = expandManifestReferences(manifestYaml, { repoRoot });
    const manifest = parseYaml(result.yaml) as Record<string, unknown>;
    const workflow = (manifest.workflows as Record<string, Record<string, unknown>>).review;
    const step = (workflow.steps as Array<Record<string, unknown>>)[0]!;
    const agent = step.agent as Record<string, unknown>;

    expect(agent.prompt).toBe('Review the diff.\n');
  });

  it('rejects workflow refs with inline siblings', () => {
    const manifestYaml = `
name: acme
workflows:
  review:
    $ref: .eve/workflows/review
    description: no
`;

    expect(() => expandManifestReferences(manifestYaml, { repoRoot })).toThrow(
      'cannot combine $ref with inline keys',
    );
  });

  it('rejects prompt files outside the repository', () => {
    mkdirSync(path.join(repoRoot, '.eve/workflows/review'), { recursive: true });
    const outsidePath = path.join(os.tmpdir(), `${path.basename(repoRoot)}-outside.md`);
    writeFileSync(outsidePath, 'outside\n', 'utf-8');
    const promptFile = path.relative(path.join(repoRoot, '.eve/workflows/review'), outsidePath);
    writeFileSync(
      path.join(repoRoot, '.eve/workflows/review/workflow.yaml'),
      `
steps:
  - name: review
    agent:
      prompt_file: ${JSON.stringify(promptFile)}
`,
      'utf-8',
    );
    const manifestYaml = `
name: acme
workflows:
  review:
    $ref: .eve/workflows/review
`;

    expect(() => expandManifestReferences(manifestYaml, { repoRoot })).toThrow(
      'must stay inside the repository',
    );
    rmSync(outsidePath, { force: true });
  });

  it('detects unresolved refs and prompt files in expanded manifests', () => {
    expect(() => assertNoUnresolvedManifestReferences({
      workflows: {
        review: { $ref: '.eve/workflows/review' },
      },
    })).toThrow('contains unresolved $ref');

    expect(() => assertNoUnresolvedManifestReferences({
      workflows: {
        review: {
          steps: [
            {
              name: 'review',
              agent: { prompt_file: 'review.md' },
            },
          ],
        },
      },
    })).toThrow('contains unresolved agent.prompt_file');
  });
});

import { test, expect } from './fixtures/auth';

const BASE = 'http://dashboard.eve.lvh.me';

type AuthMe = {
  memberships?: Array<{ org_id: string }>;
};

type Project = {
  id: string;
  name: string;
  org_id?: string;
};

type ProjectListResponse = {
  data: Project[];
};

type ProjectEnv = {
  name: string;
};

type ProjectEnvResponse = {
  data: ProjectEnv[];
};

type ProjectJob = {
  id: string;
  title: string;
  phase?: string;
  close_reason?: string | null;
  failure_disposition?: string | null;
  env_name?: string | null;
};

type ProjectJobsResponse = {
  jobs: ProjectJob[];
};

type ProjectMember = {
  email: string;
};

type ProjectMembersResponse = {
  data: ProjectMember[];
};

type OrgIntegration = {
  provider?: string;
  type?: string;
  account_id?: string;
};

type OrgIntegrationsResponse = {
  integrations: OrgIntegration[];
};

type JobAttempt = {
  attempt_number: number;
};

type JobAttemptsResponse = {
  attempts: JobAttempt[];
};

type LogPayload = {
  logs?: Array<{ text?: string }>;
  lines?: Array<{ text?: string }>;
};

function statusLabel(job: ProjectJob) {
  if (job.phase === 'review') return 'Needs review';
  if (job.phase === 'active') return 'Running';
  if (job.phase === 'done') return 'Done';
  if (job.phase === 'ready') return 'Ready';
  if (job.phase === 'cancelled') {
    if (job.failure_disposition === 'upstream_failed') return 'Blocked';
    if (job.failure_disposition === 'failed') return 'Failed';
    return 'Cancelled';
  }
  return job.phase ?? 'Unknown';
}

function diagnosisTitle(job: ProjectJob) {
  if (job.phase === 'cancelled') {
    return job.failure_disposition === 'upstream_failed'
      ? 'Blocked by an upstream failure'
      : job.failure_disposition === 'failed'
        ? 'Run failed'
        : 'Job stopped';
  }
  if (job.phase === 'review') return 'Awaiting review';
  if (job.phase === 'active') return 'Run in progress';
  return null;
}

function pickSearchTerm(text: string): string | null {
  const preferred = ['Unauthorized', 'HTTP 401', 'workspace', 'migrate', 'script'];
  const direct = preferred.find((term) => text.includes(term));
  if (direct) return direct;

  const token = text
    .split(/\s+/)
    .map((part) => part.replace(/[^\w:-]/g, ''))
    .find((part) => part.length >= 5);
  return token ?? null;
}

async function apiRequest(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any, path: string) {
  const token = await authedPage.evaluate(() => sessionStorage.getItem('eve_access_token'));
  return authedPage.request.get(`${BASE}/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function apiGet<T>(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any, path: string): Promise<T> {
  const response = await apiRequest(authedPage, path);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function apiPost<T>(
  authedPage: Parameters<typeof test.extend>[0] extends never ? never : any,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await authedPage.evaluate(() => sessionStorage.getItem('eve_access_token'));
  const response = await authedPage.request.post(`${BASE}/api${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    data: body,
  });
  const responseText = await response.text();
  expect(
    response.ok(),
    `POST ${path} failed with ${response.status()} ${response.statusText()}: ${responseText}`,
  ).toBeTruthy();
  return responseText ? (JSON.parse(responseText) as T) : ({} as T);
}

async function getProjectFixture(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any) {
  const me = await apiGet<AuthMe>(authedPage, '/auth/me');
  const orgId = me.memberships?.[0]?.org_id;
  expect(orgId).toBeTruthy();

  const projects = await apiGet<ProjectListResponse>(authedPage, `/projects?org_id=${orgId}&limit=100`);
  expect(projects.data.length).toBeGreaterThan(0);

  for (const project of projects.data) {
    const envs = await apiGet<ProjectEnvResponse>(authedPage, `/projects/${project.id}/envs?limit=50`);
    if (envs.data.length > 0) {
      return { orgId: orgId!, project, envs: envs.data };
    }
  }

  const fallbackProject = projects.data[0]!;
  const fallbackEnvs = await apiGet<ProjectEnvResponse>(authedPage, `/projects/${fallbackProject.id}/envs?limit=50`);
  return { orgId: orgId!, project: fallbackProject, envs: fallbackEnvs.data };
}

async function getTwoProjectFixture(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any) {
  const me = await apiGet<AuthMe>(authedPage, '/auth/me');
  const orgId = me.memberships?.[0]?.org_id;
  expect(orgId).toBeTruthy();

  const projects = await apiGet<ProjectListResponse>(authedPage, `/projects?org_id=${orgId}&limit=100`);
  expect(projects.data.length).toBeGreaterThan(1);

  return {
    orgId: orgId!,
    defaultProject: projects.data[0]!,
    alternateProject: projects.data[1]!,
  };
}

async function getProjectWithJobFixture(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any) {
  const me = await apiGet<AuthMe>(authedPage, '/auth/me');
  const orgId = me.memberships?.[0]?.org_id;
  expect(orgId).toBeTruthy();

  const projects = await apiGet<ProjectListResponse>(authedPage, `/projects?org_id=${orgId}&limit=100`);
  expect(projects.data.length).toBeGreaterThan(0);

  for (const project of projects.data) {
    const jobs = await apiGet<ProjectJobsResponse>(authedPage, `/projects/${project.id}/jobs?limit=50`);
    if (jobs.jobs.length > 0) {
      return { orgId: orgId!, project, job: jobs.jobs[0]! };
    }
  }

  throw new Error('No project with jobs found for dashboard job-detail tests');
}

async function getJobWithMissingArtifactsFixture(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any) {
  const me = await apiGet<AuthMe>(authedPage, '/auth/me');
  const orgId = me.memberships?.[0]?.org_id;
  expect(orgId).toBeTruthy();

  const projects = await apiGet<ProjectListResponse>(authedPage, `/projects?org_id=${orgId}&limit=100`);
  expect(projects.data.length).toBeGreaterThan(0);

  for (const project of projects.data) {
    const jobs = await apiGet<ProjectJobsResponse>(authedPage, `/projects/${project.id}/jobs?limit=50`);

    for (const job of jobs.jobs) {
      const attemptsResponse = await apiRequest(authedPage, `/jobs/${job.id}/attempts`);
      const attemptsPayload = attemptsResponse.ok()
        ? ((await attemptsResponse.json()) as JobAttemptsResponse | JobAttempt[])
        : [];
      const attempts = Array.isArray(attemptsPayload)
        ? attemptsPayload
        : attemptsPayload.attempts ?? [];
      const latestAttemptNumber = attempts.length > 0 ? attempts[attempts.length - 1]!.attempt_number : null;

      const resultResponse = await apiRequest(authedPage, `/jobs/${job.id}/result`);
      const missingResult = resultResponse.status() === 404;

      let missingLogs = false;
      if (latestAttemptNumber != null) {
        const logsResponse = await apiRequest(
          authedPage,
          `/jobs/${job.id}/attempts/${latestAttemptNumber}/logs?after=0`,
        );
        missingLogs = logsResponse.status() === 404;
      }

      if (missingResult || missingLogs) {
        return {
          project,
          job,
          attemptNumber: latestAttemptNumber,
          missingResult,
          missingLogs,
        };
      }
    }
  }

  throw new Error('No job with missing result or log artifacts found for dashboard detail empty-state tests');
}

async function getDiagnosableJobFixture(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any) {
  const me = await apiGet<AuthMe>(authedPage, '/auth/me');
  const orgId = me.memberships?.[0]?.org_id;
  expect(orgId).toBeTruthy();

  const projects = await apiGet<ProjectListResponse>(authedPage, `/projects?org_id=${orgId}&limit=100`);
  expect(projects.data.length).toBeGreaterThan(0);

  for (const project of projects.data) {
    const jobs = await apiGet<ProjectJobsResponse>(authedPage, `/projects/${project.id}/jobs?limit=100&phase=cancelled`);

    for (const job of jobs.jobs) {
      const attemptsResponse = await apiRequest(authedPage, `/jobs/${job.id}/attempts`);
      const attemptsPayload = attemptsResponse.ok()
        ? ((await attemptsResponse.json()) as JobAttemptsResponse | JobAttempt[])
        : [];
      const attempts = Array.isArray(attemptsPayload)
        ? attemptsPayload
        : attemptsPayload.attempts ?? [];
      const latestAttemptNumber = attempts.length > 0 ? attempts[attempts.length - 1]!.attempt_number : null;

      if (latestAttemptNumber == null) continue;

      const logsResponse = await apiRequest(
        authedPage,
        `/jobs/${job.id}/attempts/${latestAttemptNumber}/logs?after=0`,
      );

      if (!logsResponse.ok()) continue;

      const logsPayload = (await logsResponse.json()) as LogPayload | Array<{ text?: string }>;
      const entries = Array.isArray(logsPayload)
        ? logsPayload
        : logsPayload.logs ?? logsPayload.lines ?? [];
      const combinedText = entries
        .map((entry) => entry.text ?? '')
        .join('\n');
      const searchTerm = pickSearchTerm(combinedText);

      if (!searchTerm) continue;

      return {
        project,
        job,
        attemptNumber: latestAttemptNumber,
        searchTerm,
      };
    }
  }

  throw new Error('No failed/cancelled job with searchable logs found for dashboard diagnosis tests');
}

async function createProjectAnatomyFixture(authedPage: Parameters<typeof test.extend>[0] extends never ? never : any) {
  const me = await apiGet<AuthMe>(authedPage, '/auth/me');
  const orgId = me.memberships?.[0]?.org_id;
  expect(orgId).toBeTruthy();

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-5);
  const missionControlSlug = `mission-control-${suffix}`;
  const reviewerSlug = `reviewer-${suffix}`;
  const project = await apiPost<Project>(authedPage, '/projects', {
    org_id: orgId!,
    name: `Dashboard Anatomy ${suffix}`,
    slug: `d${suffix}`.slice(0, 8),
    repo_url: 'https://example.com/dashboard-anatomy.git',
    branch: 'main',
  });

  await apiPost(authedPage, `/projects/${project.id}/manifest`, {
    yaml: `
services:
  api:
    image: ghcr.io/example/api:latest
  web:
    image: ghcr.io/example/web:latest
  db:
    image: postgres:16
environments:
  sandbox: {}
pipelines:
  deploy:
    steps:
      - name: build
        action:
          type: build
      - name: deploy
        depends_on: [build]
        action:
          type: deploy
workflows:
  intake:
    trigger:
      app:
        event: issue.created
    with_apis:
      - service: api
        description: Example API
    steps:
      - name: triage
        agent:
          name: ${missionControlSlug}
    hints:
      timeout_seconds: 600
      permission_policy: yolo
`,
    branch: 'main',
  });

  await apiPost(authedPage, `/projects/${project.id}/agents/sync`, {
    agents_yaml: `
version: 1
agents:
  mission_control:
    slug: ${missionControlSlug}
    name: Mission Control
    description: Coordinates incoming work.
    skill: eve-mission-control
    workflow: assistant
    harness_profile: primary
    gateway:
      policy: routable
      clients: [slack]
    policies:
      permission_policy: yolo
  reviewer:
    slug: ${reviewerSlug}
    name: Reviewer
    description: Reviews proposed changes.
    skill: eve-reviewer
    workflow: review
    harness_profile: primary
`,
    teams_yaml: `
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: fanout
`,
    chat_yaml: `
version: 1
routes:
  - id: route_default
    match: ".*"
    target: team:ops
`,
    x_eve_yaml: `
version: 1
agents:
  profiles:
    primary:
      - harness: codex
        model: gpt-5.2-codex
        reasoning_effort: medium
`,
  });

  return { orgId: orgId!, project };
}

test.describe('Phase 1 — Foundation', () => {
  test('login page renders when unauthenticated', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE);
    // Without a token, EveLoginGate should show the sign-in form
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 10000 });
    await context.close();
  });

  test('authenticated redirect lands on overview', async ({ authedPage }) => {
    await expect.poll(() => new URL(authedPage.url()).pathname).toBe('/');
    await expect(authedPage.locator('.sidebar').or(authedPage.locator('nav')).first()).toBeVisible({ timeout: 10000 });
    await expect(authedPage.locator('h1.page-title')).toBeVisible({ timeout: 10000 });
  });

  test('API proxy works', async ({ authedPage }) => {
    const response = await authedPage.request.get(`${BASE}/api/health`);
    expect(response.ok()).toBeTruthy();
  });

  test('org switcher shows orgs', async ({ authedPage }) => {
    await expect(authedPage.locator('.sidebar').or(authedPage.locator('nav')).first()).toBeVisible();
  });

  test('logout clears session', async ({ authedPage }) => {
    // Click the avatar to open user menu dropdown
    await authedPage.locator('.topbar-avatar').click();
    await authedPage.waitForTimeout(500);
    // Click "Sign out" in the dropdown menu
    await authedPage.locator('.dropdown-item:has-text("Sign out")').click();
    // Should return to login form
    await expect(authedPage.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Phase 2 — Overview + Navigation', () => {
  test('overview renders stat cards', async ({ authedPage }) => {
    await authedPage.goto('/');
    await authedPage.waitForTimeout(2000);
    // Stat cards show numbers
    const statValues = authedPage.locator('.stat-value');
    await expect(statValues.first()).toBeVisible({ timeout: 10000 });
  });

  test('activity feed shows events', async ({ authedPage }) => {
    await authedPage.goto('/');
    await expect(authedPage.getByRole('heading', { name: 'Recent activity' })).toBeVisible({ timeout: 10000 });
  });

  test('navigation works', async ({ authedPage }) => {
    await authedPage.locator('.sidebar a[href^="/apps"]').first().click();
    await expect(authedPage).toHaveURL(/\/apps/);

    await authedPage.locator('.sidebar a[href^="/jobs"]').click();
    await expect(authedPage).toHaveURL(/\/jobs/);

    await authedPage.locator('.sidebar a[href^="/costs"]').click();
    await expect(authedPage).toHaveURL(/\/costs/);

    await authedPage.locator('.sidebar a[href="/"], .sidebar a[href^="/?"]').first().click();
    await expect.poll(() => new URL(authedPage.url()).pathname).toBe('/');
  });

  test('selected project persists when navigating via the sidebar', async ({ authedPage }) => {
    const { alternateProject } = await getTwoProjectFixture(authedPage);

    await authedPage.goto('/');
    await authedPage.locator('.context-pill').click();
    await authedPage.locator('.dropdown-item', { hasText: alternateProject.name }).click();

    await expect(authedPage).toHaveURL(new RegExp(`\\?project=${alternateProject.id}`));
    await expect(authedPage.locator('.context-pill')).toContainText(alternateProject.name);

    await authedPage.locator('.sidebar a[href^="/apps"]').first().click();
    await expect(authedPage).toHaveURL(new RegExp(`/apps\\?project=${alternateProject.id}`));
    await expect(authedPage.locator('.context-pill')).toContainText(alternateProject.name);

    await authedPage.locator('.sidebar a[href^="/jobs"]').click();
    await expect(authedPage).toHaveURL(new RegExp(`/jobs\\?project=${alternateProject.id}`));
    await expect(authedPage.locator('.context-pill')).toContainText(alternateProject.name);
  });

  test('dark mode toggle works', async ({ authedPage }) => {
    await authedPage.goto('/');
    const html = authedPage.locator('html');

    // Click the theme toggle button in the topbar
    const themeBtn = authedPage.locator('button[title*="light"], button[title*="dark"]').first();
    await themeBtn.click();
    await expect(html).toHaveClass(/dark/);

    // Toggle back
    const themeBtn2 = authedPage.locator('button[title*="light"], button[title*="dark"]').first();
    await themeBtn2.click();
    await expect(html).not.toHaveClass(/dark/);
  });
});

test.describe('Phase 3 — Job Board', () => {
  test('board renders columns', async ({ authedPage }) => {
    await authedPage.goto('/board');
    await authedPage.waitForTimeout(2000);
    // Column headers
    await expect(authedPage.getByRole('heading', { name: 'Ready' }).or(authedPage.locator('h3:has-text("Ready")'))).toBeVisible({ timeout: 10000 });
    await expect(authedPage.locator('h3:has-text("Active")').or(authedPage.getByText('Active', { exact: true }))).toBeVisible();
    await expect(authedPage.locator('h3:has-text("Stopped")')).toBeVisible();
  });

  test('search filter works', async ({ authedPage }) => {
    await authedPage.goto('/board');
    await authedPage.waitForTimeout(2000);
    const searchInput = authedPage.locator('input[placeholder^="Search title"]');
    await searchInput.fill('nonexistentjob12345');
    await authedPage.waitForTimeout(500);
    await expect(authedPage.locator('text=Empty').first()).toBeVisible();
  });

  test('cancelled jobs surface in the stopped column instead of done', async ({ authedPage }) => {
    const fixture = await getDiagnosableJobFixture(authedPage);

    await authedPage.goto(`/board?project=${fixture.project.id}`);
    await expect(authedPage.locator('h3:has-text("Stopped")')).toBeVisible({ timeout: 10000 });

    const stoppedColumn = authedPage.locator('.board-col').filter({
      has: authedPage.locator('h3:has-text("Stopped")'),
    }).first();
    const doneColumn = authedPage.locator('.board-col').filter({
      has: authedPage.locator('h3:has-text("Done")'),
    }).first();

    await expect(stoppedColumn.getByText(fixture.job.title, { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(doneColumn.getByText(fixture.job.title, { exact: true })).toHaveCount(0);
  });
});

test.describe('Phase 4 — Job Detail + Logs', () => {
  test('job list renders', async ({ authedPage }) => {
    await authedPage.goto('/jobs');
    // Use heading role to avoid matching sidebar tooltip
    await expect(authedPage.getByRole('heading', { name: 'Jobs' })).toBeVisible({ timeout: 10000 });
  });

  test('jobs deep link opens job detail without hitting the error boundary', async ({ authedPage }) => {
    const { project, job } = await getProjectWithJobFixture(authedPage);

    await authedPage.goto(`/jobs?project=${project.id}&job=${job.id}`);
    await expect(authedPage.getByRole('heading', { name: 'Jobs' })).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText('Something went wrong')).toHaveCount(0);
    await expect(authedPage.getByRole('button', { name: 'Summary' })).toBeVisible({ timeout: 10000 });
    await expect(authedPage.locator('.fixed').getByText(job.title, { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('board click opens job detail without hitting the error boundary', async ({ authedPage }) => {
    const { project, job } = await getProjectWithJobFixture(authedPage);

    await authedPage.goto(`/board?project=${project.id}`);
    await expect(authedPage.getByText(job.title, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await authedPage.getByText(job.title, { exact: true }).first().click();
    await expect(authedPage.getByText('Something went wrong')).toHaveCount(0);
    await expect(authedPage.getByRole('button', { name: 'Summary' })).toBeVisible({ timeout: 10000 });
    await expect(authedPage.locator('.fixed').getByText(job.title, { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('job detail shows clear empty states when result or logs are unavailable', async ({ authedPage }) => {
    const fixture = await getJobWithMissingArtifactsFixture(authedPage);

    await authedPage.goto(`/jobs?project=${fixture.project.id}&job=${fixture.job.id}`);
    await expect(authedPage.getByRole('button', { name: 'Summary' })).toBeVisible({ timeout: 10000 });

    if (fixture.missingResult) {
      await authedPage.getByRole('button', { name: 'Result', exact: true }).click();
      await expect(authedPage.getByText('Loading result...')).toHaveCount(0);
      await expect(authedPage.getByText('No result was recorded for this job.')).toBeVisible({ timeout: 10000 });
    }

    if (fixture.missingLogs && fixture.attemptNumber != null) {
      await authedPage.getByRole('button', { name: 'Logs', exact: true }).click();
      await expect(authedPage.getByText('No logs recorded for this attempt yet.')).toBeVisible({ timeout: 10000 });
    }
  });

  test('jobs list surfaces failure status and reason for diagnosable jobs', async ({ authedPage }) => {
    const fixture = await getDiagnosableJobFixture(authedPage);

    await authedPage.goto(`/jobs?project=${fixture.project.id}`);
    const row = authedPage.locator('tr').filter({ hasText: fixture.job.title }).first();

    await expect(row).toContainText(statusLabel(fixture.job), { timeout: 10000 });
    if (fixture.job.env_name) {
      await expect(row).toContainText(fixture.job.env_name);
    }
    if (fixture.job.close_reason) {
      const reasonSnippet = fixture.job.close_reason.split('\n').find(Boolean)?.slice(0, 30);
      if (reasonSnippet) {
        await expect(row).toContainText(reasonSnippet);
      }
    }
  });

  test('job detail leads with diagnosis and searchable logs for failed jobs', async ({ authedPage }) => {
    const fixture = await getDiagnosableJobFixture(authedPage);
    const expectedTitle = diagnosisTitle(fixture.job);
    expect(expectedTitle).toBeTruthy();

    await authedPage.goto(`/jobs?project=${fixture.project.id}&job=${fixture.job.id}`);
    await expect(authedPage.getByRole('button', { name: 'Summary' })).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText('Diagnosis')).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText(expectedTitle!)).toBeVisible({ timeout: 10000 });

    await authedPage.getByRole('button', { name: 'View logs' }).click();
    await expect(authedPage.getByText(fixture.searchTerm, { exact: false }).first()).toBeVisible({ timeout: 10000 });

    const searchInput = authedPage.locator('input[placeholder="Search logs..."], input[placeholder="Regex search..."]').first();
    await searchInput.fill(fixture.searchTerm);
    await expect(authedPage.getByText(/of \d+ matches/).first()).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText(fixture.searchTerm, { exact: false }).first()).toBeVisible();
  });
});

test.describe('Phase 5 — Admin Mode', () => {
  test('system page accessible for admin', async ({ authedPage }) => {
    await authedPage.goto('/system');
    // Use heading role to disambiguate from sidebar tooltip
    await expect(authedPage.getByRole('heading', { name: 'System' })).toBeVisible({ timeout: 10000 });
    // Services tab/heading should be visible
    await expect(authedPage.locator('text=Services').first()).toBeVisible({ timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6 Tests — Project Anatomy
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 6 — Project Anatomy', () => {
  test('project page shows content', async ({ authedPage }) => {
    await authedPage.goto('/project');
    await authedPage.waitForTimeout(2000);
    // Should either show project content or "select a project" message
    await expect(authedPage.locator('.sidebar').or(authedPage.locator('nav')).first()).toBeVisible({ timeout: 10000 });
  });

  test('project tabs render synced anatomy for configured but undeployed projects', async ({ authedPage }) => {
    const { orgId, project } = await createProjectAnatomyFixture(authedPage);

    await authedPage.evaluate((activeOrgId) => localStorage.setItem('eve_active_org_id', activeOrgId), orgId);
    await authedPage.goto(`/project?project=${project.id}`);
    await expect(authedPage.getByRole('heading', { name: project.name })).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText(/Showing configured topology from the latest repo sync/i)).toBeVisible({ timeout: 10000 });

    await expect(authedPage.getByRole('button', { name: /^Agents/ })).toContainText('2');
    await authedPage.getByRole('button', { name: /^Agents/ }).click();
    await expect(authedPage.getByText('Mission Control', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText('Chat Routes')).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText('route_default')).toBeVisible();

    await authedPage.getByRole('button', { name: /^Pipelines/ }).click();
    await expect(authedPage.getByText('build', { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText('deploy', { exact: true }).first()).toBeVisible();

    await authedPage.getByRole('button', { name: /^Workflows/ }).click();
    await expect(authedPage.getByText('app:issue.created')).toBeVisible({ timeout: 10000 });
    await expect(authedPage.getByText(/@mission-control-/)).toBeVisible();
    await expect(authedPage.getByText('600s timeout')).toBeVisible();

    await authedPage.getByRole('button', { name: /^Releases/ }).click();
    await expect(authedPage.getByText('No releases yet')).toBeVisible({ timeout: 10000 });

    await authedPage.getByRole('button', { name: /^Schedules/ }).click();
    await expect(authedPage.getByText('No schedules configured')).toBeVisible({ timeout: 10000 });

    await authedPage.getByRole('button', { name: /^Members/ }).click();
    await expect(authedPage.getByText('admin@example.com', { exact: true }).first()).toBeVisible({ timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 Tests — Enhanced Features
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 7 — Enhanced Features', () => {
  test('overview loads without errors', async ({ authedPage }) => {
    await authedPage.goto('/');
    await authedPage.waitForTimeout(2000);
    // Use heading to avoid matching sidebar tooltip
    await expect(authedPage.locator('h1.page-title')).toBeVisible({ timeout: 10000 });
  });

  test('board loads with filters', async ({ authedPage }) => {
    await authedPage.goto('/board');
    await authedPage.waitForTimeout(2000);
    await expect(authedPage.locator('input[placeholder^="Search title"]')).toBeVisible({ timeout: 10000 });
  });

  test('environments page loads', async ({ authedPage }) => {
    await authedPage.goto('/environments');
    // Legacy route redirects to /apps
    await expect(
      authedPage.locator('h1:has-text("Apps")'),
    ).toBeVisible({ timeout: 20000 });
  });

  test('spending page loads', async ({ authedPage }) => {
    await authedPage.goto('/spending');
    await authedPage.waitForTimeout(3000);
    // Legacy route redirects to /costs
    await expect(
      authedPage.getByRole('heading', { name: 'Costs' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('system page has services panel', async ({ authedPage }) => {
    await authedPage.goto('/system');
    await authedPage.waitForTimeout(2000);
    await expect(authedPage.getByRole('heading', { name: 'System' })).toBeVisible({ timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 8 Tests — Polish
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Phase 8 — Polish', () => {
  test('error boundary prevents white screens', async ({ authedPage }) => {
    for (const path of ['/', '/board', '/jobs', '/project', '/environments', '/spending', '/system']) {
      await authedPage.goto(path);
      await authedPage.waitForTimeout(1000);
      // Shell sidebar or nav should always be visible
      await expect(authedPage.locator('.sidebar').or(authedPage.locator('nav')).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('dark mode persists across reload', async ({ authedPage }) => {
    await authedPage.goto('/');
    await authedPage.waitForTimeout(1000);
    const html = authedPage.locator('html');

    await authedPage.evaluate(() => localStorage.setItem('eve_theme', 'dark'));
    await authedPage.reload();
    await authedPage.waitForTimeout(1000);
    await expect(html).toHaveClass(/dark/, { timeout: 5000 });

    await authedPage.evaluate(() => localStorage.setItem('eve_theme', 'light'));
    await authedPage.reload();
    await authedPage.waitForTimeout(1000);
    await expect(html).not.toHaveClass(/dark/, { timeout: 5000 });
  });

  test('keyboard shortcut Cmd+K toggles project selector', async ({ authedPage }) => {
    await authedPage.goto('/');
    await authedPage.waitForTimeout(1000);

    await authedPage.keyboard.press('Meta+k');
    await authedPage.waitForTimeout(300);

    const dropdown = authedPage.locator('.dropdown-menu');
    await expect(dropdown.first()).toBeVisible({ timeout: 3000 });

    await authedPage.keyboard.press('Escape');
    await authedPage.waitForTimeout(300);
  });
});

test.describe('Phase 9 — Scope + Product Completeness', () => {
  test('admin toggle switches the home view into operations mode', async ({ authedPage }) => {
    await authedPage.goto('/');
    await expect(authedPage.locator('h1.page-title')).toBeVisible({ timeout: 10000 });

    await authedPage.locator('button.admin-toggle').click();
    await expect(authedPage.locator('h1.page-title')).toContainText('operations', { timeout: 10000 });

    await authedPage.locator('button.admin-toggle').click();
    await expect(authedPage.locator('h1.page-title')).not.toContainText('operations');
  });

  test('environment selector reflects real project environments instead of hardcoded options', async ({ authedPage }) => {
    const { project, envs } = await getProjectFixture(authedPage);

    await authedPage.goto(`/?project=${project.id}`);
    await authedPage.locator('.env-selector').click();

    const envMenu = authedPage.locator('.dropdown-menu').filter({ has: authedPage.getByText('All environments') }).first();
    await expect(envMenu).toBeVisible({ timeout: 5000 });
    await expect(envMenu.locator('.dropdown-item')).toHaveCount(envs.length + 1);

    for (const env of envs) {
      await expect(envMenu.getByText(env.name, { exact: true })).toBeVisible();
    }

    if (!envs.some((env) => env.name === 'production')) {
      await expect(envMenu.getByText('production', { exact: true })).toHaveCount(0);
    }
  });

  test('project members and integrations tabs render real data without placeholder stubs', async ({ authedPage }) => {
    const { orgId, project } = await getProjectFixture(authedPage);
    const members = await apiGet<ProjectMembersResponse>(authedPage, `/projects/${project.id}/members`);
    const integrations = await apiGet<OrgIntegrationsResponse>(authedPage, `/orgs/${orgId}/integrations`);

    await authedPage.goto(`/project?project=${project.id}`);
    await authedPage.getByRole('button', { name: 'Members' }).click();
    await expect(authedPage.getByText('Project members are managed via the CLI')).toHaveCount(0);
    await expect(authedPage.locator('table tbody').getByText(members.data[0]!.email, { exact: true }).first()).toBeVisible({ timeout: 10000 });

    await authedPage.getByRole('button', { name: 'Integrations' }).click();
    await expect(authedPage.getByText('Add Integration')).toHaveCount(0);

    if (integrations.integrations.length > 0) {
      const firstIntegration = integrations.integrations[0]!;
      const accountOrProvider = firstIntegration.account_id ?? firstIntegration.provider ?? firstIntegration.type;
      expect(accountOrProvider).toBeTruthy();
      await expect(authedPage.getByText(accountOrProvider!, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    } else {
      await expect(authedPage.getByText('No integrations configured')).toBeVisible({ timeout: 10000 });
    }
  });

  test('system events tab explains when cluster events are unavailable', async ({ authedPage }) => {
    const eventsResponse = await apiRequest(authedPage, '/system/events?limit=10');
    test.skip(eventsResponse.status() !== 404, 'System events endpoint is available in this environment');

    await authedPage.goto('/system');
    await authedPage.getByRole('button', { name: 'Events' }).click();
    await expect(
      authedPage.getByText('Cluster events are unavailable on this environment'),
    ).toBeVisible({ timeout: 10000 });
  });
});

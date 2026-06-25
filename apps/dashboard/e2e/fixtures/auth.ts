import { test as base, type Page } from '@playwright/test';
import { execSync } from 'child_process';

const DASHBOARD_URL = 'http://dashboard.eve.lvh.me';

type AuthFixtures = {
  authedPage: Page;
};

function getEveToken(): string {
  // First ensure we're logged in
  try {
    execSync(
      'EVE_API_URL=http://api.eve.lvh.me eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519 2>/dev/null',
      { encoding: 'utf-8' },
    );
  } catch {
    // Login may fail if already logged in, that's fine
  }

  // Get the token via eve auth token
  const token = execSync('EVE_API_URL=http://api.eve.lvh.me eve auth token 2>/dev/null', {
    encoding: 'utf-8',
  }).trim();

  if (!token || token.length < 10) {
    throw new Error('Failed to get Eve auth token');
  }

  return token;
}

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ browser }, use) => {
    const token = getEveToken();
    const context = await browser.newContext({ baseURL: DASHBOARD_URL });
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate((t) => sessionStorage.setItem('eve_access_token', t), token);
    await page.reload();
    await page.waitForTimeout(2000); // Wait for auth provider to bootstrap
    await use(page);
    await context.close();
  },
});

export { expect } from '@playwright/test';

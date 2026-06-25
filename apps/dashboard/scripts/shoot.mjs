#!/usr/bin/env node
// Screenshot harness for the dashboard redesign loop.
//
// Shoots every route at mobile (390x844) and desktop (1440x900) viewports
// with an injected Eve auth token, writing PNGs to tmp/playwright-browser/screenshots/.
//
// Usage:
//   node scripts/shoot.mjs [--url http://dashboard.eve.lvh.me] [--token <tok>] [--routes /,/apps]
//   EVE_API_URL=http://api.eve.lvh.me node scripts/shoot.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const DASHBOARD_URL = argValue('--url') ?? 'http://dashboard.eve.lvh.me';
const API_URL = process.env.EVE_API_URL ?? 'http://api.eve.lvh.me';
const OUT_DIR = argValue('--out') ?? path.resolve(process.cwd(), '../../tmp/playwright-browser/screenshots');
const SUFFIX = argValue('--suffix') ?? '';

const ROUTES = (argValue('--routes') ?? '/,/apps,/jobs,/jobs?view=board,/costs,/system,/apps/project')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

const THEME = argValue('--theme') ?? 'dark';
const ADMIN_SCOPE = process.argv.includes('--admin');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
];

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function getToken() {
  const explicit = argValue('--token');
  if (explicit) return explicit;
  try {
    return execFileSync('eve', ['auth', 'token', '--raw'], {
      encoding: 'utf-8',
      env: { ...process.env, EVE_API_URL: API_URL },
    }).trim();
  } catch {
    return execFileSync('eve', ['auth', 'token'], {
      encoding: 'utf-8',
      env: { ...process.env, EVE_API_URL: API_URL },
    }).trim();
  }
}

function routeSlug(route) {
  const cleaned = route.replace(/^\//, '').replace(/[/?=&]+/g, '-') || 'home';
  return cleaned.replace(/-+$/, '');
}

const token = getToken();
if (!token || token.length < 10) {
  console.error('Failed to mint an Eve token. Log in first.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
    });
    // Inject the token + theme before any page script runs
    await context.addInitScript(({ t, theme, adminScope }) => {
      try {
        sessionStorage.setItem('eve_access_token', t);
        localStorage.setItem('eve_theme', theme);
        if (adminScope) sessionStorage.setItem('eve_admin_scope', '1');
      } catch {}
    }, { t: token, theme: THEME, adminScope: ADMIN_SCOPE });

    const page = await context.newPage();
    for (const route of ROUTES) {
      const url = `${DASHBOARD_URL}${route}`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      } catch {
        // capture whatever rendered
      }
      await page.waitForTimeout(2500);
      const file = path.join(OUT_DIR, `${routeSlug(route)}-${viewport.name}${SUFFIX}.png`);
      await page.screenshot({ path: file, fullPage: viewport.name === 'desktop' });
      console.log(`✓ ${file}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

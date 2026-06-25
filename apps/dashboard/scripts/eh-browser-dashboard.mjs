#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { chromium } from '@playwright/test';

function printHelp() {
  console.log(`Usage: eh browser dashboard [url] [options]

Open headed Chromium with the repo Playwright version and optionally inject
an Eve access token into sessionStorage.

Options:
  --no-auth                  Skip eve_access_token injection
  --token <token>            Use an explicit Eve token instead of eve auth token --raw
  --eve-api-url <url>        API URL used when minting a token
  --viewport-size <w,h>      Browser viewport, default 1440,960
  -h, --help                 Show this help
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseViewport(value) {
  const [widthRaw, heightRaw] = value.split(',');
  const width = Number.parseInt(widthRaw ?? '', 10);
  const height = Number.parseInt(heightRaw ?? '', 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    fail(`Invalid viewport size: ${value}`);
  }
  return { width, height };
}

function parseArgs(argv) {
  const options = {
    defaultApiUrl: 'http://api.eve.lvh.me',
    defaultUrl: 'http://dashboard.eve.lvh.me',
    eveApiUrl: undefined,
    injectAuth: true,
    profile: undefined,
    token: undefined,
    url: undefined,
    viewport: { width: 1440, height: 960 },
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      case '--profile':
        options.profile = argv[index + 1];
        index += 1;
        break;
      case '--default-url':
        options.defaultUrl = argv[index + 1];
        index += 1;
        break;
      case '--default-api-url':
        options.defaultApiUrl = argv[index + 1];
        index += 1;
        break;
      case '--eve-api-url':
        options.eveApiUrl = argv[index + 1];
        index += 1;
        break;
      case '--token':
        options.token = argv[index + 1];
        index += 1;
        break;
      case '--viewport-size':
        options.viewport = parseViewport(argv[index + 1] ?? '');
        index += 1;
        break;
      case '--no-auth':
        options.injectAuth = false;
        break;
      default:
        if (arg.startsWith('--')) {
          fail(`Unknown option: ${arg}`);
        }
        if (options.url) {
          fail(`Unexpected extra argument: ${arg}`);
        }
        options.url = arg;
    }
  }

  if (!options.profile) {
    fail('Missing required --profile argument');
  }

  options.url ??= options.defaultUrl;
  options.eveApiUrl ??= process.env.EVE_API_URL || options.defaultApiUrl;
  return options;
}

function getEveToken(apiUrl) {
  try {
    return execFileSync('eve', ['auth', 'token', '--raw'], {
      encoding: 'utf8',
      env: { ...process.env, EVE_API_URL: apiUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    fail(
      `Failed to get an Eve token for ${apiUrl}. Run 'EVE_API_URL=${apiUrl} eve auth login' and retry.${stderr ? `\n${stderr}` : ''}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.profile, { recursive: true });

  const context = await chromium.launchPersistentContext(options.profile, {
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: options.viewport,
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  if (options.injectAuth) {
    const token = options.token || getEveToken(options.eveApiUrl);
    if (!token || token.length < 10) {
      fail(`Received an invalid Eve token for ${options.eveApiUrl}`);
    }

    await page.evaluate((eveToken) => {
      sessionStorage.setItem('eve_access_token', eveToken);
    }, token);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  console.log(`Opened ${options.url}`);
  console.log(`Profile: ${options.profile}`);
  if (options.injectAuth) {
    console.log(`Injected eve_access_token from ${options.eveApiUrl}`);
  } else {
    console.log('Opened without auth injection');
  }
  console.log('Close the browser window to end this session.');

  const browser = context.browser();
  await new Promise((resolve) => {
    const close = async () => {
      try {
        await context.close();
      } catch {
        // Ignore shutdown races.
      }
      resolve();
    };

    process.once('SIGINT', close);
    process.once('SIGTERM', close);

    if (browser) {
      browser.once('disconnected', resolve);
      return;
    }

    context.once('close', resolve);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

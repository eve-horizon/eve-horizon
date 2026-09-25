import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const BROWSER_PATH_KEYS = ['PLAYWRIGHT_BROWSERS_PATH', 'LD_LIBRARY_PATH', 'FONTCONFIG_FILE'] as const;

export function rejectBrowserPathOverrides(toolchains: readonly string[], overrides: Record<string, string> | null | undefined): void {
  if (!toolchains.includes('browser')) return;
  const key = BROWSER_PATH_KEYS.find((candidate) => Object.hasOwn(overrides ?? {}, candidate));
  if (key) throw new Error(`toolchain_unavailable: browser env_overrides may not set ${key}`);
}

export interface BrowserProbeResult {
  playwright: string;
  chromium: string;
  screenshot_sha256: string;
  box: { width: number; height: number };
}

/** Verify the declared payload in the final child environment and workspace. */
export async function probeBrowserRuntime(env: NodeJS.ProcessEnv, cwd: string, root = '/opt/eve/toolchains'): Promise<BrowserProbeResult> {
  const wrapper = path.join(root, 'browser/bin/eve-browser-python');
  const probe = path.join(root, 'browser/probe.py');
  const browserManifest = JSON.parse(await fs.readFile(path.join(root, 'browser/python/playwright/driver/package/browsers.json'), 'utf8')) as {
    browsers: { name: string; browserVersion: string }[];
  };
  const expectedChromium = browserManifest.browsers.find((browser) => browser.name === 'chromium-headless-shell')?.browserVersion;
  if (!expectedChromium) throw new Error('browser setup failed: bundled Playwright browser manifest has no headless Chromium version');
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-browser-probe-'));
  const child = spawn(wrapper, [probe], {
    cwd,
    env: { ...env, EVE_BROWSER_PROBE_DIR: outputDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) throw new Error(`browser launch probe failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-4000)}`);
    const result = JSON.parse(Buffer.concat(stdout).toString('utf8').trim()) as BrowserProbeResult;
    if (!result.playwright || !result.chromium || !result.screenshot_sha256 || result.box.width !== 40 || result.box.height !== 20) {
      throw new Error('browser launch probe produced incomplete geometry or version evidence');
    }
    if (result.chromium !== expectedChromium) {
      throw new Error(`browser launch probe version mismatch: Playwright expects Chromium ${expectedChromium}, launched ${result.chromium}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

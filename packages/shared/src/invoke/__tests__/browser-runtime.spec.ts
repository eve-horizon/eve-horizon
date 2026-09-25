import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeBrowserRuntime, rejectBrowserPathOverrides } from '../browser-runtime.js';

describe('browser runtime declaration', () => {
  it('rejects browser path overrides as setup errors', () => {
    for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'LD_LIBRARY_PATH', 'FONTCONFIG_FILE']) {
      expect(() => rejectBrowserPathOverrides(['python', 'browser'], { [key]: '/untrusted' }))
        .toThrow(/toolchain_unavailable: browser env_overrides/);
    }
    expect(() => rejectBrowserPathOverrides(['python'], { PLAYWRIGHT_BROWSERS_PATH: '/custom' })).not.toThrow();
  });

  it('fails setup when the launched Chromium differs from the bundled client manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-browser-version-'));
    try {
      const browser = path.join(root, 'browser');
      await fs.mkdir(path.join(browser, 'bin'), { recursive: true });
      await fs.mkdir(path.join(browser, 'python/playwright/driver/package'), { recursive: true });
      await fs.writeFile(path.join(browser, 'python/playwright/driver/package/browsers.json'), JSON.stringify({
        browsers: [{ name: 'chromium-headless-shell', browserVersion: '153.0.8010.12' }],
      }));
      await fs.writeFile(path.join(browser, 'bin/eve-browser-python'),
        '#!/bin/sh\necho \'{"playwright":"1.63.0","chromium":"0.0.0.0","screenshot_sha256":"abc","box":{"width":40,"height":20}}\'\n',
        { mode: 0o755 });
      await expect(probeBrowserRuntime({ PATH: '/usr/bin' }, root, root)).rejects.toThrow(/version mismatch/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

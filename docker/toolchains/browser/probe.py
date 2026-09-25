"""Small launch probe used by provisioning and the image smoke test."""

import hashlib
from importlib.metadata import version as package_version
import json
import os
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright


def main():
    output = Path(os.environ.get("EVE_BROWSER_PROBE_DIR", "/tmp/eve-browser-probe"))
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        profile_dirs = [
            str(path) for path in Path(tempfile.gettempdir()).glob("playwright_chromiumdev_profile-*")
        ]
        assert profile_dirs, "Chromium did not create a writable temporary profile"
        page = browser.new_page()
        page.set_content('<div id="text">Browser ready</div><svg><rect id="box" width="40" height="20"/></svg>')
        text = page.locator("#text").inner_text()
        box = page.locator("#box").bounding_box()
        screenshot = output / "probe.png"
        page.screenshot(path=str(screenshot))
        chromium_version = browser.version
        browser.close()
    assert text == "Browser ready", text
    assert box and box["width"] == 40 and box["height"] == 20, box
    assert screenshot.stat().st_size > 0
    memory_peak = Path("/sys/fs/cgroup/memory.peak")
    print(json.dumps({
        "playwright": package_version("playwright"),
        "chromium": chromium_version,
        "screenshot_bytes": screenshot.stat().st_size,
        "screenshot_sha256": hashlib.sha256(screenshot.read_bytes()).hexdigest(),
        "uid": os.getuid(),
        "profile_dirs": profile_dirs,
        "memory_peak_bytes": int(memory_peak.read_text()) if memory_peak.exists() else None,
        "output_bytes": sum(path.stat().st_size for path in output.rglob("*") if path.is_file()),
        "box": box,
    }, sort_keys=True))


if __name__ == "__main__":
    main()

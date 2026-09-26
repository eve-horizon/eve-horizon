"""Run inside a declared python+browser job through eve-browser-python."""

import base64
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright


EXPECTED_TEXT = "Browser runtime ready"


def main():
    fixture = Path("browser-runtime-page.html")
    assert fixture.is_file(), f"missing fixture: {fixture}"
    job_id = os.environ["EVE_JOB_ID"]
    attempt_id = os.environ["EVE_ATTEMPT_ID"]
    output = Path("browser-runtime-output")
    output.mkdir(exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix=f"eve-browser-{attempt_id}-"))
    screenshot = output / "screenshot.png"

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile), headless=True, viewport={"width": 640, "height": 480}
        )
        page = context.new_page()
        page.set_content(fixture.read_text(encoding="utf-8"))
        text = page.locator("#text").inner_text()
        box = page.locator("#box").bounding_box()
        chromium = (context.browser.version if context.browser else
                    subprocess.check_output([playwright.chromium.executable_path, "--version"],
                                            text=True).strip().split()[-1])
        assert text == EXPECTED_TEXT, text
        assert box and box["width"] == 40 and box["height"] == 20, box
        page.screenshot(path=str(screenshot))
        context.close()

    image_marker = Path("/opt/eve/toolchains/browser/.installed")
    source = image_marker.read_text(encoding="utf-8").strip() if image_marker.exists() else None
    screenshot_bytes = screenshot.read_bytes()
    assert screenshot_bytes.startswith(b"\x89PNG\r\n\x1a\n") and len(screenshot_bytes) > 100
    runtime_digest = os.environ.get("EVE_RUNTIME_IMAGE_DIGEST")
    if not runtime_digest and source:
        diagnosis = json.loads(subprocess.check_output(
            ["eve", "job", "diagnose", job_id, "--json"], text=True
        ))
        attempt = next(item for item in diagnosis["attempts"] if item["id"] == attempt_id)
        metadata = attempt.get("runtime_meta") or {}
        runtime_digest = ((metadata.get("browser") or {}).get("runtime_image_digest") or
                          (metadata.get("toolchains") or {}).get("runtime_image_digest"))
    if source and not runtime_digest:
        raise RuntimeError("inline browser attempt has no deployed runtime image digest")
    receipt = {
        "job_id": job_id,
        "attempt_id": attempt_id,
        "playwright": version("playwright"),
        "chromium": chromium,
        "browser_source_image": source,
        "runtime_image_digest": runtime_digest,
        "text": text,
        "box": {"width": box["width"], "height": box["height"]},
        "profile": str(profile),
        "screenshot_bytes": len(screenshot_bytes),
        "screenshot_sha256": hashlib.sha256(screenshot_bytes).hexdigest(),
        "uid": os.getuid(),
        "gid": os.getgid(),
    }
    receipt_path = output / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n", encoding="utf-8")
    encoded_path = output / "screenshot.png.b64"
    encoded_path.write_text(base64.b64encode(screenshot_bytes).decode("ascii") + "\n", encoding="ascii")
    subprocess.run(["eve", "job", "attach", job_id, "--name", "browser-runtime-receipt.json",
                    "--file", str(receipt_path), "--mime", "application/json"], check=True)
    subprocess.run(["eve", "job", "attach", job_id, "--name", "browser-runtime-screenshot.png.b64",
                    "--file", str(encoded_path), "--mime", "text/plain"], check=True)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()

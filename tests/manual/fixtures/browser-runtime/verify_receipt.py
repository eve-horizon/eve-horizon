"""Check downloaded job attachments against observed attempt metadata."""

import argparse
import base64
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--screenshot-b64", type=Path, required=True)
    parser.add_argument("--diagnose", type=Path, required=True)
    parser.add_argument("--runtime-digest", required=True,
                        help="exact deployed worker or agent-runtime image sha256 digest")
    parser.add_argument("--pod-json", type=Path,
                        help="runner pod JSON captured while live, for main-container imageID")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
    diagnosis = json.loads(args.diagnose.read_text(encoding="utf-8"))
    attempts = diagnosis["attempts"]
    attempt = next(item for item in attempts if item["id"] == receipt["attempt_id"])
    assert diagnosis["job"]["phase"] == "done", "job has not completed successfully"
    assert attempt["job_id"] == receipt["job_id"]
    assert attempt["attempt_number"] == max(item["attempt_number"] for item in attempts), (
        "receipt is from an older attempt"
    )
    assert attempt["status"] == "succeeded" and attempt["exit_code"] == 0 and attempt["ended_at"], (
        "receipt attempt is not a successful terminal attempt"
    )
    metadata = attempt.get("runtime_meta") or {}
    browser = metadata.get("browser") or {}
    toolchains = metadata.get("toolchains") or {}
    png = base64.b64decode(args.screenshot_b64.read_text(encoding="ascii"), validate=False)

    assert diagnosis["job"]["id"] == receipt["job_id"]
    assert receipt["text"] == "Browser runtime ready"
    assert receipt["box"] == {"width": 40, "height": 20}
    assert receipt["playwright"] == "1.63.0"
    assert receipt["chromium"] == "153.0.8010.12"
    assert receipt["uid"] == receipt["gid"] == 1000
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(png) == receipt["screenshot_bytes"] > 100
    assert hashlib.sha256(png).hexdigest() == receipt["screenshot_sha256"]
    assert browser.get("playwright") == receipt["playwright"]
    assert browser.get("chromium") == receipt["chromium"]
    observed_box = browser.get("box") or {}
    assert {axis: observed_box.get(axis) for axis in ("width", "height")} == receipt["box"]
    assert args.runtime_digest.startswith("sha256:")

    source = receipt["browser_source_image"]
    inline = bool(source)
    if inline:
        assert "@sha256:" in source
        observed = (browser.get("source_image_digest") or
                    toolchains.get("browser_source_image_digest"))
        assert source.rsplit("@", 1)[1] == observed
    else:
        image_id = (toolchains.get("image_ids") or {}).get("browser")
        assert image_id and "sha256:" in image_id, "runner needs pulled browser init imageID"
        source = image_id

    observed_runtime = browser.get("runtime_image_digest") or toolchains.get("runtime_image_digest")
    if inline:
        assert observed_runtime == receipt["runtime_image_digest"] == args.runtime_digest, (
            "inline runtime digest must be present in both metadata and receipt"
        )
    else:
        assert args.pod_json, "runner requires captured pod JSON"
        pod = json.loads(args.pod_json.read_text(encoding="utf-8"))
        assert pod["metadata"]["name"] == metadata["pod_name"]
        main_ids = [entry["imageID"] for entry in pod["status"]["containerStatuses"]
                    if entry["name"] == "runner"]
        assert len(main_ids) == 1 and args.runtime_digest in main_ids[0]

    receipt["browser_source_image"] = source
    receipt["runtime_image_digest"] = args.runtime_digest
    receipt["attempt_runtime_meta"] = metadata
    args.out.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"verified {receipt['job_id']} {receipt['attempt_id']} {receipt['screenshot_sha256']}")


if __name__ == "__main__":
    main()

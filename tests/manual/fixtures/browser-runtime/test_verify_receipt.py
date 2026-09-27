"""Run against captured script and agent evidence (EVE_BROWSER_EVIDENCE_DIR)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(os.getenv("EVE_BROWSER_EVIDENCE_DIR", "/private/tmp"))
VERIFIER = Path(__file__).with_name("verify_receipt.py")


def check(prefix, edit=lambda receipt, diagnosis: None):
    receipt = json.loads((ROOT / f"{prefix}.receipt.json").read_text())
    diagnosis = json.loads((ROOT / f"{prefix}.diagnose.json").read_text())
    edit(receipt, diagnosis)
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder)
        (path / "r").write_text(json.dumps(receipt))
        (path / "d").write_text(json.dumps(diagnosis))
        result = subprocess.run([
            sys.executable, str(VERIFIER), "--receipt", str(path / "r"),
            "--diagnose", str(path / "d"), "--screenshot-b64",
            str(ROOT / f"{prefix}.png.b64"), "--runtime-digest",
            receipt["runtime_image_digest"], "--out", str(path / "out"),
        ], capture_output=True)
        return result.returncode, (path / "out").exists()


@unittest.skipUnless((ROOT / "browser-fe2a5d56.1.diagnose.json").exists(),
                     "set EVE_BROWSER_EVIDENCE_DIR to captured live evidence")
class ReceiptTests(unittest.TestCase):
    def test_actual_positives(self):
        for prefix in ("browser-fe2a5d56.1", "browser-15c4a45e.1"):
            self.assertEqual(check(prefix), (0, True))

    def test_rejections(self):
        edits = (
            lambda r, d: d["job"].update(phase="active"),
            lambda r, d: d["attempts"][0].update(status="failed"),
            lambda r, d: d["attempts"][0].update(exit_code=1),
            lambda r, d: d["attempts"].append(dict(d["attempts"][0], id="new", attempt_number=2)),
            lambda r, d: r["box"].update(width=39),
            lambda r, d: r.update(screenshot_sha256="0" * 64),
            lambda r, d: r.update(job_id="wrong"),
        )
        for edit in edits:
            with self.subTest(edit=edit):
                self.assertEqual(check("browser-fe2a5d56.1", edit), (1, False))


if __name__ == "__main__":
    unittest.main()

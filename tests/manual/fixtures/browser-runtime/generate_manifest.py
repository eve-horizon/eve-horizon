"""Generate pre-merge local workflows with the checked-in fixture embedded."""

import base64
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent


def block(value, indent):
    return "\n".join(" " * indent + line for line in value.splitlines())


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: generate_manifest.py <disposable-git-checkout>")
    target = Path(sys.argv[1]).resolve()
    if not (target / ".git").exists():
        raise SystemExit("target must be a disposable Git checkout")
    fixture = base64.b64encode((ROOT / "page.html").read_bytes()).decode("ascii")
    probe = base64.b64encode((ROOT / "browser_probe.py").read_bytes()).decode("ascii")
    command = ("set -eu\n"
               f"printf %s '{fixture}' | base64 -d > browser-runtime-page.html\n"
               f"printf %s '{probe}' | base64 -d > browser_probe.py\n"
               "/opt/eve/toolchains/browser/bin/eve-browser-python browser_probe.py")
    prompt = ("Run this exact shell command in the job workspace. Report its exit code and the "
              "JSON receipt printed by the program. The program attaches the receipt and a "
              "base64 PNG to this job; do not claim success unless it exits zero.\n\n"
              "```sh\n" + command + "\n```")
    manifest = ("name: browser-runtime-manual\n"
                "workflows:\n"
                "  browser-script:\n"
                "    steps:\n"
                "      - name: render\n"
                "        toolchains: [python, browser]\n"
                "        script:\n"
                "          run: |\n" + block(command, 12) + "\n"
                "  browser-path-override:\n"
                "    steps:\n"
                "      - name: blocked\n"
                "        toolchains: [python, browser]\n"
                "        env_overrides:\n"
                "          PLAYWRIGHT_BROWSERS_PATH: /tmp/forbidden-override\n"
                "        script:\n"
                "          run: |\n" + block(command, 12) + "\n"
                "  browser-agent:\n"
                "    steps:\n"
                "      - name: render\n"
                "        harness: codex\n"
                "        toolchains: [python, browser]\n"
                "        agent:\n"
                "          name: browser_probe\n"
                "          prompt: |\n" + block(prompt, 12) + "\n")
    (target / ".eve").mkdir(exist_ok=True)
    (target / ".eve" / "manifest.yaml").write_text(manifest, encoding="utf-8")
    (target / "agents").mkdir(exist_ok=True)
    (target / "agents" / "agents.yaml").write_text(
        "version: 1\nagents:\n  browser_probe:\n    slug: browser-probe\n"
        "    description: Browser runtime verification agent.\n"
        "    skill: browser-probe\n    workflow: assistant\n"
        "    policies:\n      permission_policy: auto_edit\n", encoding="utf-8")
    print(target / ".eve" / "manifest.yaml")


if __name__ == "__main__":
    main()

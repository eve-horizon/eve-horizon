# Third-Party Components

Eve Horizon's source code is licensed under the [MIT License](LICENSE). The
dependency tree is entirely permissive (MIT / ISC / Apache-2.0 / BSD and
similar); no copyleft licenses are present. Standard dependency attributions
travel with each package via the package manager.

## Bundled agent CLIs (container images only)

Eve Horizon invokes external agent "harness" CLIs at runtime. These are **not**
part of this repository or any published npm package — they are installed into
the worker and agent-runtime **container images** at build time
(`apps/worker/Dockerfile`, `apps/agent-runtime/Dockerfile`), gated behind the
`INSTALL_CLAUDE` / `INSTALL_CODEX` / `INSTALL_GEMINI` build args. Each is the
property of its respective vendor and is subject to its own license and terms
of service (which may require a separate account or API key):

| Tool | Package | Vendor |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-code` | Anthropic |
| Codex CLI | `@openai/codex` | OpenAI |
| Gemini CLI | `@google/gemini-cli` | Google |
| cc-mirror (mints the `mclaude` / `zai` Claude Code variants) | `cc-mirror` | see package |

If you build and distribute Eve Horizon container images, those images contain
the above third-party tools and you are responsible for complying with their
licenses and terms. To build a "clean" image without them, set the corresponding
`INSTALL_*` build arg to `false`.

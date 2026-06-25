ARG NODE_BASE_IMAGE=node:22-slim
FROM ${NODE_BASE_IMAGE} AS base
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/agent-runtime/package.json ./apps/agent-runtime/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/migrate/package.json ./packages/migrate/
COPY packages/eve-agent-cli/package.json ./packages/eve-agent-cli/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm --filter @eve/shared build \
    && pnpm --filter @eve/db build \
    && pnpm --filter @eve/migrate build \
    && pnpm --filter @eve/eve-agent-cli build \
    && pnpm --filter @eve-horizon/cli build \
    && pnpm --filter @eve/agent-runtime build

FROM gcr.io/go-containerregistry/crane:v0.20.3 AS crane

FROM base AS production

ARG KUBECTL_VERSION=stable
RUN set -eu; \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git bash jq poppler-utils \
    && mkdir -p /home/node/.local/bin /home/node/.cc-mirror /opt/eve/workspaces /opt/eve/cache /opt/eve/state /opt/eve/toolchains \
    && chown -R node:node /home/node /opt/eve \
    && if [ "$KUBECTL_VERSION" = "stable" ]; then \
         KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"; \
       fi \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && rm -rf /var/lib/apt/lists/*

# --- Media processing tools (ffmpeg + whisper.cpp) ---
RUN set -eu; \
    apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg cmake make g++ \
    && git clone --depth 1 --branch v1.8.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper-build \
    && cd /tmp/whisper-build \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build -j$(nproc) --target whisper-cli \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && mkdir -p /opt/whisper/models \
    && curl -L -o /opt/whisper/models/ggml-small.en.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
    && rm -rf /tmp/whisper-build \
    && apt-get purge -y --auto-remove cmake make g++ \
    && rm -rf /var/lib/apt/lists/*

ARG HARNESS_INSTALL_CACHE_BUST=latest
ARG CC_MIRROR_PACKAGE=cc-mirror@latest
ARG CLAUDE_CODE_PACKAGE=@anthropic-ai/claude-code@latest
ARG CODEX_PACKAGE=@openai/codex@latest
ARG GEMINI_PACKAGE=@google/gemini-cli@latest
ARG CODE_PACKAGE=@just-every/code@latest
ARG PI_PACKAGE=@mariozechner/pi-coding-agent@latest
ARG SKILLS_PACKAGE=skills@1.5.3
RUN set -eu; \
    echo "Harness package refresh: ${HARNESS_INSTALL_CACHE_BUST}"; \
    npm install -g \
       "$CC_MIRROR_PACKAGE" \
       "$CLAUDE_CODE_PACKAGE" \
       "$CODEX_PACKAGE" \
       "$GEMINI_PACKAGE" \
       "$CODE_PACKAGE" \
       "$PI_PACKAGE" \
       "$SKILLS_PACKAGE" \
    && rm -rf /root/.npm \
    && (HOME=/home/node cc-mirror quick --provider mirror --name mclaude --yes --no-shell-env 2>/dev/null || true) \
    && (HOME=/home/node cc-mirror quick --provider zai --name zai --api-key "placeholder" --yes --no-shell-env 2>/dev/null || true) \
    && if [ -f /home/node/.cc-mirror/zai/config/settings.json ]; then \
         node -e "const fs=require('fs'); const f='/home/node/.cc-mirror/zai/config/settings.json'; const d=JSON.parse(fs.readFileSync(f)); delete d.env.ANTHROPIC_API_KEY; fs.writeFileSync(f,JSON.stringify(d,null,2));" 2>/dev/null || true; \
       fi \
    && if [ -x /home/node/.local/bin/mclaude ]; then ln -sf /home/node/.local/bin/mclaude /usr/local/bin/mclaude; \
       else printf '#!/bin/sh\nexec claude "$@"\n' > /usr/local/bin/mclaude && chmod +x /usr/local/bin/mclaude; fi \
    && if [ -x /home/node/.local/bin/zai ]; then ln -sf /home/node/.local/bin/zai /usr/local/bin/zai; \
       else printf '#!/bin/sh\nexec claude "$@"\n' > /usr/local/bin/zai && chmod +x /usr/local/bin/zai; fi \
    && chown -R node:node /home/node

ARG EVE_BUILD_VERSION=dev
ARG EVE_BUILD_SHA=unknown
ARG EVE_BUILD_TIME=unknown
ENV EVE_BUILD_VERSION=${EVE_BUILD_VERSION}
ENV EVE_BUILD_SHA=${EVE_BUILD_SHA}
ENV EVE_BUILD_TIME=${EVE_BUILD_TIME}
ENV DISABLE_TELEMETRY=1
ENV HOME=/home/node

COPY --from=crane /ko-app/crane /usr/local/bin/crane
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/agent-runtime/node_modules ./apps/agent-runtime/node_modules
COPY --from=build /app/apps/agent-runtime/dist ./apps/agent-runtime/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/eve-agent-cli/dist ./packages/eve-agent-cli/dist
COPY --from=build /app/packages/eve-agent-cli/bin ./packages/eve-agent-cli/bin
COPY --from=build /app/packages/eve-agent-cli/node_modules ./packages/eve-agent-cli/node_modules
COPY --from=build /app/packages/eve-agent-cli/package.json ./packages/eve-agent-cli/
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/packages/cli/bin ./packages/cli/bin
COPY --from=build /app/packages/cli/package.json ./packages/cli/
RUN ln -sf /app/packages/eve-agent-cli/bin/eve-agent-cli.js /usr/local/bin/eve-agent-cli
RUN ln -sf /app/packages/cli/bin/eve.js /usr/local/bin/eve
ENV PATH="/home/node/.local/bin:/app/packages/eve-agent-cli/bin:${PATH}"
WORKDIR /app/apps/agent-runtime
USER node
CMD ["node", "dist/main.js"]

FROM dependencies AS development
COPY . .
CMD ["pnpm", "--filter", "@eve/agent-runtime", "dev"]

FROM production AS runtime

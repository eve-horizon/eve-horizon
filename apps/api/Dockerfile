ARG NODE_BASE_IMAGE=node:22-slim
FROM ${NODE_BASE_IMAGE} AS base
RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm --filter @eve/shared build && pnpm --filter @eve/db build && pnpm --filter @eve/api build

FROM base AS production

# Build metadata (passed via --build-arg in CI)
ARG EVE_BUILD_VERSION=dev
ARG EVE_BUILD_SHA=unknown
ARG EVE_BUILD_TIME=unknown
ENV EVE_BUILD_VERSION=${EVE_BUILD_VERSION}
ENV EVE_BUILD_SHA=${EVE_BUILD_SHA}
ENV EVE_BUILD_TIME=${EVE_BUILD_TIME}

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]

FROM dependencies AS development
COPY . .
CMD ["pnpm", "--filter", "@eve/api", "dev"]

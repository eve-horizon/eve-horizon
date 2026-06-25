FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY tsconfig.base.json pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json ./apps/gateway/
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth/package.json ./packages/auth/
RUN pnpm install --frozen-lockfile

COPY apps/gateway ./apps/gateway
COPY packages/shared ./packages/shared
COPY packages/auth ./packages/auth

RUN pnpm --filter @eve/shared build && pnpm --filter @eve-horizon/auth build && pnpm --filter @eve/gateway build

FROM node:22-alpine AS production
WORKDIR /app
RUN corepack enable

COPY tsconfig.base.json pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json ./apps/gateway/
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth/package.json ./packages/auth/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/auth/dist ./packages/auth/dist
COPY --from=build /app/packages/auth/package.json ./packages/auth/

WORKDIR /app/apps/gateway
EXPOSE 4820
CMD ["node", "dist/main.js"]

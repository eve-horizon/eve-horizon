FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/sso/package.json ./apps/sso/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/sso ./apps/sso
COPY packages/shared ./packages/shared

RUN pnpm --filter @eve/shared build && pnpm --filter @eve/sso build

FROM node:22-alpine AS production
WORKDIR /app
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/sso/package.json ./apps/sso/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/sso/dist ./apps/sso/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules

WORKDIR /app/apps/sso
EXPOSE 3100
CMD ["node", "dist/main.js"]

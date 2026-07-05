FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/auth-react/package.json ./packages/auth-react/
COPY packages/auth/package.json ./packages/auth/
COPY apps/dashboard/package.json ./apps/dashboard/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/auth-react ./packages/auth-react
COPY packages/auth ./packages/auth
COPY apps/dashboard ./apps/dashboard

# Build auth then auth-react (auth-react re-exports auth's wire types)
RUN pnpm --filter @eve-horizon/auth build
RUN pnpm --filter @eve-horizon/auth-react build
RUN pnpm --filter @eve/dashboard build

FROM node:22-alpine AS production
WORKDIR /app

# Install production server dependencies
RUN npm install --no-save express@4 http-proxy-middleware@3

COPY --from=build /app/apps/dashboard/dist ./dist
COPY --from=build /app/apps/dashboard/server.js ./server.js

EXPOSE 3200
CMD ["node", "server.js"]

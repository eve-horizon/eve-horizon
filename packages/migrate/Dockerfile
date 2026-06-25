FROM node:22-slim

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json ./

# Install dependencies (no lockfile - standalone package)
RUN pnpm install --prod

# Copy built files
COPY dist/ ./dist/

# Default migrations directory
ENV MIGRATIONS_DIR=/migrations

# Run the migration script
CMD ["node", "dist/index.js"]

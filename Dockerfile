# ── Stage 1: Install & Build ──────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package manifests first (cache layer for dependency install)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/web/package.json packages/web/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/dashboard/package.json packages/dashboard/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build shared, then web + server
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm --filter @coder/shared build && pnpm build

# Install bundled skills (CloudBase guidelines, etc.)
# scripts/ already copied via COPY . .
RUN sh scripts/install-skills.sh

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config and server + shared manifests only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
# Stub web/dashboard package.json so pnpm workspace resolution doesn't fail
RUN mkdir -p packages/web packages/dashboard && \
    echo '{"name":"@coder/web","version":"0.1.0","private":true}' > packages/web/package.json && \
    echo '{"name":"@coder/dashboard","version":"0.1.0","private":true}' > packages/dashboard/package.json

# Install production dependencies only for server + shared
RUN CI=true pnpm install --no-frozen-lockfile --prod --ignore-scripts

# Copy built artifacts
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

# Copy bundled skills directly into packages/server/skills/ (no symlink needed)
# skill-loader-override reads CODEBUDDY_BUNDLED_SKILLS_DIR = packages/server/skills
COPY --from=build /app/.agents/skills/cloudbase ./packages/server/skills/cloudbase

# Point shared exports to built dist (source .ts files not available at runtime)
RUN sed -i 's|./src/index.ts|./dist/index.js|g' packages/shared/package.json

# Server resolves web dist as resolve(__dirname, '../web/dist') where __dirname = packages/server/dist
# This resolves to packages/server/web/dist, so symlink it to the actual web dist
RUN ln -s /app/packages/web /app/packages/server/web

RUN mkdir -p packages/server/.data

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80

CMD ["node", "packages/server/dist/index.js"]

# Build from the repo root:  docker build -f agent/Dockerfile .
FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY agent/package.json agent/
COPY packages/agent-pay-kit/package.json packages/agent-pay-kit/
COPY apps/seeker-app/package.json apps/seeker-app/

# The owner web app, served at /app for phones without the Android app (iPhones included).
FROM base AS web
ARG PUBLIC_URL=https://tilltide.bytez3.com
RUN pnpm install --frozen-lockfile --filter @tilltide/seeker-app...
COPY packages/agent-pay-kit packages/agent-pay-kit
COPY apps/seeker-app apps/seeker-app
RUN cd apps/seeker-app && \
    EXPO_BASE_URL=/app EXPO_PUBLIC_API_URL=$PUBLIC_URL EXPO_PUBLIC_APP_URI=$PUBLIC_URL npx expo export -p web --output-dir /web && \
    sed -i 's#%BASE_URL%#/app#g' /web/index.html

# Install only what the API needs (agent + agent-pay-kit), using the lockfile.
FROM base
RUN pnpm install --frozen-lockfile --filter @tilltide/agent... --prod=false

COPY packages/agent-pay-kit packages/agent-pay-kit
COPY agent agent
COPY --from=web /web /web

ENV NODE_ENV=production WEB_DIR=/web
EXPOSE 8787
# Migrations are idempotent; run them on every start so a fresh database just works.
CMD ["sh", "-c", "pnpm --filter @tilltide/agent exec tsx src/db/migrate.ts && pnpm --filter @tilltide/agent exec tsx src/server.ts"]

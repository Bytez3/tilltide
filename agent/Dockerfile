# Build from the repo root:  docker build -f agent/Dockerfile .
FROM node:22-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

# Install only what the API needs (agent + agent-pay-kit), using the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY agent/package.json agent/
COPY packages/agent-pay-kit/package.json packages/agent-pay-kit/
COPY apps/seeker-app/package.json apps/seeker-app/
RUN pnpm install --frozen-lockfile --filter @tilltide/agent... --prod=false

COPY packages/agent-pay-kit packages/agent-pay-kit
COPY agent agent

ENV NODE_ENV=production
EXPOSE 8787
# Migrations are idempotent; run them on every start so a fresh database just works.
CMD ["sh", "-c", "pnpm --filter @tilltide/agent exec tsx src/db/migrate.ts && pnpm --filter @tilltide/agent exec tsx src/server.ts"]

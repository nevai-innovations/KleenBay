FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @carwash/shared build && pnpm --filter @carwash/api build

FROM build AS runtime-deps
RUN pnpm --filter @carwash/api deploy --prod --legacy /runtime

FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /app/apps/api
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM node:22-trixie-slim AS runtime
ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/app/certs/us-east-1-bundle.pem
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY docker/certs/us-east-1-bundle.pem certs/us-east-1-bundle.pem
COPY --from=runtime-deps /runtime/node_modules apps/api/node_modules
COPY --from=runtime-deps /runtime/package.json apps/api/package.json
COPY --from=runtime-deps /runtime/dist apps/api/dist
RUN mkdir -p /app/.local-data/uploads && chown -R node:node /app/.local-data
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

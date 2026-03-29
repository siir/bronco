FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY mcp-servers/database/package.json mcp-servers/database/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/shared-types/ packages/shared-types/
COPY packages/shared-utils/ packages/shared-utils/
COPY mcp-servers/database/ mcp-servers/database/
RUN pnpm --filter @bronco/shared-types run build
RUN pnpm --filter @bronco/shared-utils run build
RUN pnpm --filter @bronco/mcp-database run build

FROM base AS production
COPY --from=build /app /app
RUN pnpm prune --prod
EXPOSE 3100
USER node
CMD ["node", "mcp-servers/database/dist/index.js"]

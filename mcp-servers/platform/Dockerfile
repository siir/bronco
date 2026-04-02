FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma/schema.prisma packages/db/prisma/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY mcp-servers/platform/package.json mcp-servers/platform/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY mcp-servers/platform/ mcp-servers/platform/
RUN pnpm --filter @bronco/shared-types run build
RUN pnpm --filter @bronco/db run build
RUN pnpm --filter @bronco/shared-utils run build
RUN pnpm --filter @bronco/mcp-platform run build

FROM base AS production
COPY --from=build /app /app
RUN pnpm prune --prod
EXPOSE 3110
USER node
CMD ["node", "mcp-servers/platform/dist/index.js"]

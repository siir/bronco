FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma/schema.prisma packages/db/prisma/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY mcp-servers/repo/package.json mcp-servers/repo/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY mcp-servers/repo/ mcp-servers/repo/
RUN pnpm --filter @bronco/shared-types run build
RUN pnpm --filter @bronco/db run build
RUN pnpm --filter @bronco/shared-utils run build
RUN pnpm --filter @bronco/mcp-repo run build

FROM base AS production
RUN apk add --no-cache git
COPY --from=build /app /app
RUN pnpm prune --prod
EXPOSE 3111
USER node
CMD ["node", "mcp-servers/repo/dist/index.js"]

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma/schema.prisma packages/db/prisma/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY packages/ai-provider/package.json packages/ai-provider/
COPY services/copilot-api/package.json services/copilot-api/
COPY services/imap-worker/package.json services/imap-worker/
COPY mcp-servers/database/package.json mcp-servers/database/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY services/copilot-api/ services/copilot-api/
RUN pnpm --filter @bronco/shared-types run build
RUN pnpm --filter @bronco/db run build
RUN pnpm --filter @bronco/shared-utils run build
RUN pnpm --filter @bronco/ai-provider run build
RUN pnpm --filter @bronco/copilot-api run build

FROM base AS production
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION
COPY --from=build /app /app
RUN pnpm prune --prod
# pnpm prune rewrites bin wrappers with host paths. Create a clean wrapper
# that invokes the prisma CLI directly so `prisma migrate deploy` works.
RUN printf '#!/bin/sh\nexec node /app/packages/db/node_modules/prisma/build/index.js "$@"\n' > /usr/local/bin/prisma \
    && chmod +x /usr/local/bin/prisma
COPY services/copilot-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
CMD ["docker-entrypoint.sh"]

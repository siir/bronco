FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache git openssh-client
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma/schema.prisma packages/db/prisma/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY packages/ai-provider/package.json packages/ai-provider/
COPY services/issue-resolver/package.json services/issue-resolver/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY services/issue-resolver/ services/issue-resolver/
RUN pnpm --filter @bronco/shared-types run build
RUN pnpm --filter @bronco/db run build
RUN pnpm --filter @bronco/shared-utils run build
RUN pnpm --filter @bronco/ai-provider run build
RUN pnpm --filter @bronco/issue-resolver run build

FROM base AS production
COPY --from=build /app /app
RUN pnpm prune --prod
USER node
CMD ["node", "services/issue-resolver/dist/index.js"]

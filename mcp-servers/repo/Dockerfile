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
RUN apk add --no-cache git openssh-client tree file
COPY --from=build /app /app
RUN pnpm prune --prod
RUN mkdir -p /var/lib/mcp-repo/repos \
    && chown -R node:node /var/lib/mcp-repo

# Pre-populate SSH known_hosts for the common git forges so the first
# `git clone git@…` attempt does not fail with "Host key verification failed".
# Without this the container has no known_hosts at all and every SSH-URL
# clone aborts before reaching auth. See issue #367.
RUN mkdir -p /home/node/.ssh \
    && ssh-keyscan -T 5 -t rsa,ed25519 github.com gitlab.com bitbucket.org \
         >> /home/node/.ssh/known_hosts 2>/dev/null \
    && chown -R node:node /home/node/.ssh \
    && chmod 700 /home/node/.ssh \
    && chmod 644 /home/node/.ssh/known_hosts

COPY --chown=node:node mcp-servers/repo/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3111
USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "mcp-servers/repo/dist/index.js"]

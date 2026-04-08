# --- Build stage: build the Control Panel Angular app ---
FROM node:20-alpine AS build-cp

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/control-panel/package.json services/control-panel/
COPY packages/shared-ui/package.json packages/shared-ui/

# Install dependencies
RUN --mount=type=secret,id=fontawesome_npm_auth_token,env=FONTAWESOME_NPM_AUTH_TOKEN \
    pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-ui/ packages/shared-ui/
COPY services/control-panel/ services/control-panel/

# Build Angular production bundle
RUN pnpm --filter @bronco/control-panel run build

# --- Build stage: build the Ticket Portal Angular app ---
FROM node:20-alpine AS build-portal

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/ticket-portal/package.json services/ticket-portal/
COPY packages/shared-ui/package.json packages/shared-ui/

# Install dependencies
RUN --mount=type=secret,id=fontawesome_npm_auth_token,env=FONTAWESOME_NPM_AUTH_TOKEN \
    pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-ui/ packages/shared-ui/
COPY services/ticket-portal/ services/ticket-portal/

# Build Angular production bundle
RUN pnpm --filter @bronco/ticket-portal run build

# --- Caddy build stage: add Tailscale cert plugin ---
FROM caddy:2-builder AS caddy-build
RUN xcaddy build --with github.com/tailscale/caddy-tailscale

# --- Serve stage: serve static files with Caddy ---
FROM caddy:2-alpine
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy

# Copy the Angular build outputs
COPY --from=build-cp /app/services/control-panel/dist/control-panel/browser /srv/control-panel
COPY --from=build-portal /app/services/ticket-portal/dist/ticket-portal/browser /srv/ticket-portal
# Dev-only fallback Caddyfile — overridden by the bind-mounted Caddyfile in docker-compose.yml
RUN echo ':80 { root * /srv/control-panel; try_files {path} /index.html; file_server }' > /etc/caddy/Caddyfile

COPY services/control-panel/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

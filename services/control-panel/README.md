# @bronco/control-panel

Angular 19 web application for managing the Bronco operations platform. Provides a UI for clients, tickets, systems, integrations, AI configuration, service health monitoring, and more.

## Runs On

**Hugo** (control plane VM) via Docker Compose — built as a static bundle and served by Caddy alongside the Ticket Portal.

## How It Works

The control panel is a single-page Angular app that communicates with the copilot-api REST backend. In production, Caddy serves the static files and reverse-proxies `/api/*` requests to the copilot-api container. In development, Angular CLI's dev server proxies API calls to `localhost:3000`.

### Features

- **Dashboard** — Overview of recent activity
- **Clients** — Client management (CRUD, contacts, systems)
- **Tickets** — Ticket list with filtering, detail view with event timeline
- **Systems** — Database system connection management
- **Repos** — Code repository management for issue resolution
- **Integrations** — Third-party service integrations
- **Prompts** — AI prompt management (system prompts, overrides, model config)
- **AI Usage** — AI provider usage analytics
- **Logs** — Application log viewer
- **Slack Conversations** — Slack conversation history viewer
- **System Status** — Service health monitoring dashboard
- **Notification Preferences** — Per-operator notification preference management
- **Settings** — Application configuration

## Development

```bash
# From monorepo root
pnpm dev:panel

# Or from this directory
ng serve --proxy-config proxy.conf.json
```

Runs on `http://localhost:4200` with API proxy to `http://localhost:3000`.

## Deployment (Hugo)

The Dockerfile builds both the control-panel and ticket-portal Angular apps, then serves them via a Caddy container with the Tailscale cert plugin:

- Control panel → `/srv/control-panel` (served at `/cp/`)
- Ticket portal → `/srv/ticket-portal` (served at `/portal/`)

The Caddyfile in docker-compose.yml handles routing and SPA fallback.

## Source Layout

```
src/app/
├── app.component.ts          # Root component
├── app.config.ts             # App configuration
├── app.routes.ts             # Route definitions
├── core/
│   ├── guards/               # Route guards (auth)
│   ├── interceptors/         # HTTP interceptors (auth tokens)
│   └── services/             # Core services (API client, auth)
└── features/
    ├── activity-feed/        # Activity/event feed
    ├── ai-providers/         # AI provider configuration
    ├── ai-usage/             # AI usage analytics
    ├── clients/              # Client management
    ├── contacts/             # Contact directory
    ├── dashboard/            # Main dashboard
    ├── email-logs/           # Email processing log viewer
    ├── failed-jobs/          # BullMQ failed job management
    ├── ingestion-jobs/       # Ingestion pipeline run viewer
    ├── integrations/         # Third-party integrations
    ├── login/                # Authentication
    ├── logs/                 # System logs viewer
    ├── notification-channels/ # Notification channel config
    ├── notification-preferences/ # Per-operator notification preferences
    ├── profile/              # User profile
    ├── prompts/              # AI prompt management
    ├── release-notes/        # Release notes viewer
    ├── repos/                # Code repository management
    ├── scheduled-probes/     # Scheduled probe management
    ├── settings/             # Configuration settings
    ├── slack-conversations/  # Slack conversation viewer
    ├── system-analysis/      # System closure analysis
    ├── system-issues/        # System issue tracking
    ├── system-settings/      # System-level settings
    ├── system-status/        # Service health monitoring
    ├── systems/              # Database systems management
    ├── ticket-routes/        # Configurable analysis pipelines
    ├── tickets/              # Ticket/issue management
    └── users/                # Internal user management
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@angular/material` | UI component library |
| `@angular/cdk` | Component Dev Kit |
| `rxjs` | Reactive extensions |

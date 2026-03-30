# @bronco/ticket-portal

Client-facing Angular web application that allows client portal users to submit tickets, view their ticket history, and track ticket status. Scoped to a single client — users can only see tickets belonging to their organization.

## Runs On

**Hugo** (control plane VM) via Docker Compose. Built as a stage within `services/control-panel/Dockerfile` — does NOT have its own Dockerfile or build matrix entry.

## Features

- **Dashboard** — Ticket statistics by status (open, in progress, waiting, resolved/closed)
- **Ticket list** — View and filter tickets for the client's organization
- **Ticket detail** — View ticket timeline, add comments, upload attachments
- **Ticket creation** — Submit new tickets (pushed to the unified ingestion queue)
- **User management** — View and manage portal users within the client's organization
- **Profile** — View/update own profile
- **Registration** — Self-registration for new portal users (when `allowSelfRegistration` is enabled on the client)

## Authentication

Portal users authenticate via JWT tokens issued by the `POST /api/portal/auth/login` endpoint on copilot-api. Tokens are scoped to `clientId` — all data access is filtered by the client the user belongs to.

## Development

```bash
pnpm dev:portal  # Angular dev server on port 4201
```

## Source Layout

```
src/app/
├── core/
│   ├── guards/               # Route guards (auth)
│   ├── interceptors/         # HTTP interceptors (auth tokens)
│   └── services/             # Core services (API client, auth)
├── shared/                   # Shared components, pipes, directives
└── features/
    ├── dashboard/            # Ticket statistics dashboard
    ├── login/                # Portal login
    ├── register/             # Self-registration
    ├── profile/              # User profile
    ├── tickets/              # Ticket list + detail + creation
    └── users/                # Portal user management
```

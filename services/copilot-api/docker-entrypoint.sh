#!/bin/sh
set -e

echo "Running Prisma migrations..."
prisma migrate deploy --schema=packages/db/prisma/schema.prisma

echo "Starting copilot-api..."
exec node services/copilot-api/dist/index.js

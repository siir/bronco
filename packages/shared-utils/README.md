# @bronco/shared-utils

Shared runtime utilities used across all services and the MCP server.

## Exports

### `createLogger(name: string): pino.Logger`

Creates a Pino logger instance. Writes to stderr (important for MCP servers, which use stdout for protocol communication). Respects `LOG_LEVEL` env var.

```typescript
import { createLogger } from '@bronco/shared-utils';
const logger = createLogger('my-service');
logger.info({ port: 3000 }, 'Server started');
```

### `loadConfig<T>(schema: ZodSchema<T>): T`

Loads and validates environment variables against a Zod schema. Calls `dotenv.config()` automatically. Throws with a formatted error message listing all validation failures.

```typescript
import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  API_KEY: z.string().min(1),
});
const config = loadConfig(schema);
```

### `encrypt(plaintext: string, keyHex: string): string`

AES-256-GCM encryption. The `keyHex` is a 64-character hex string (32 bytes). Returns a string in the format `iv:authTag:ciphertext` (all base64).

```typescript
import { encrypt, decrypt } from '@bronco/shared-utils';

const key = 'a'.repeat(64); // 32-byte key as hex
const encrypted = encrypt('my-password', key);
const decrypted = decrypt(encrypted, key); // 'my-password'
```

Used to encrypt SQL Server passwords stored in the `systems` table.

### `createQueue(name: string, redisUrl: string): Queue`

BullMQ Queue factory.

### `createWorker<T, R>(name: string, redisUrl: string, processor): Worker<T, R>`

BullMQ Worker factory.

```typescript
import { createQueue, createWorker } from '@bronco/shared-utils';

const queue = createQueue('email-ingestion', 'redis://localhost:6379');
const worker = createWorker('email-ingestion', 'redis://localhost:6379', async (job) => {
  // process job.data
});
```

### Additional Exports

| Export | Module | Description |
|--------|--------|-------------|
| `AppLogger`, `createPrismaLogWriter`, `setGlobalLogWriter` | `app-logger.ts` | Structured application logging with DB persistence |
| `createHealthServer` | `health-server.ts` | Standalone HTTP health endpoint for workers |
| `createGracefulShutdown` | `graceful-shutdown.ts` | Graceful shutdown with cleanup hooks |
| `Mailer` | `mailer.ts` | SMTP email sending (nodemailer wrapper) |
| `notifyOperators` | `notify-operators.ts` | Broadcast notifications to active operators |
| `callMcpToolWithAuth`, `callMcpToolViaSdk` | `mcp-client.ts` | MCP tool invocation helpers |
| `buildUtcCron` | `cron-tz.ts` | Timezone-aware cron expression builder |
| `looksEncrypted` | `crypto.ts` | Check if a string looks like an encrypted value |

## Source Layout

```
src/
├── index.ts              # Barrel exports
├── logger.ts             # Pino logger factory
├── app-logger.ts         # Structured app logging with DB persistence
├── config.ts             # Zod-based env config loader
├── crypto.ts             # AES-256-GCM encrypt/decrypt + looksEncrypted
├── queue.ts              # BullMQ Queue and Worker factories
├── health-server.ts      # Standalone HTTP health endpoint
├── graceful-shutdown.ts   # Graceful shutdown with cleanup hooks
├── mailer.ts             # SMTP email sending (nodemailer)
├── mcp-client.ts         # MCP tool invocation helpers
├── cron-tz.ts            # Timezone-aware cron expression builder
└── notify-operators.ts   # Broadcast notifications to active operators
```

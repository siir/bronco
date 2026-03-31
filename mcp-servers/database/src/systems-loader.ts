import type { PrismaClient } from '@bronco/db';
import { createLogger, decrypt } from '@bronco/shared-utils';
import type { SystemConfigEntry } from './config.js';

const logger = createLogger('systems-loader');

export async function loadSystemsFromDb(
  db: PrismaClient,
  encryptionKey: string,
): Promise<SystemConfigEntry[]> {
  const rows = await db.system.findMany({
    where: { isActive: true },
    include: { client: { select: { name: true, shortCode: true } } },
  });

  logger.info({ count: rows.length }, 'Loaded active systems from DB');

  return rows.map((row) => {
    let password: string | null = null;
    if (row.encryptedPassword) {
      try {
        password = decrypt(row.encryptedPassword, encryptionKey);
      } catch (err) {
        logger.warn(
          { systemId: row.id, name: row.name, err: (err as Error).message },
          'Failed to decrypt system password — skipping password',
        );
      }
    }

    return {
      id: row.id,
      clientId: row.clientId,
      clientName: row.client.name,
      clientCode: row.client.shortCode,
      name: row.name,
      dbEngine: row.dbEngine,
      host: row.host,
      port: row.port,
      connectionString: row.connectionString,
      instanceName: row.instanceName,
      defaultDatabase: row.defaultDatabase,
      authMethod: row.authMethod,
      username: row.username,
      password,
      useTls: row.useTls,
      trustServerCert: row.trustServerCert,
      connectionTimeout: row.connectionTimeout,
      requestTimeout: row.requestTimeout,
      maxPoolSize: row.maxPoolSize,
      environment: row.environment,
    };
  });
}

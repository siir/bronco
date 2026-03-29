import fp from 'fastify-plugin';
import { getDb, disconnectDb } from '@bronco/db';
import type { PrismaClient } from '@bronco/db';

declare module 'fastify' {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

export const prismaPlugin = fp(async (fastify) => {
  const db = getDb();
  fastify.decorate('db', db);
  fastify.addHook('onClose', async () => {
    await disconnectDb();
  });
});

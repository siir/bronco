import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

export async function healthRoutes(fastify: FastifyInstance, opts: { config: Config }): Promise<void> {
  fastify.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString(), version: opts.config.BUILD_VERSION };
  });
}

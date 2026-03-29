import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';

export async function artifactRoutes(fastify: FastifyInstance, opts: { config: Config }): Promise<void> {
  const storagePath = opts.config.ARTIFACT_STORAGE_PATH;

  fastify.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request) => {
    const artifact = await fastify.db.artifact.findUnique({
      where: { id: request.params.id },
    });
    if (!artifact) return fastify.httpErrors.notFound('Artifact not found');
    return artifact;
  });

  fastify.get<{ Params: { id: string } }>('/api/artifacts/:id/download', async (request, reply) => {
    const artifact = await fastify.db.artifact.findUnique({
      where: { id: request.params.id },
    });
    if (!artifact) return fastify.httpErrors.notFound('Artifact not found');

    const filePath = join(storagePath, artifact.storagePath);
    reply.header('Content-Type', artifact.mimeType);
    reply.header('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    return reply.send(createReadStream(filePath));
  });

  fastify.post<{ Querystring: { ticketId?: string; findingId?: string; description?: string } }>(
    '/api/artifacts/upload',
    async (request, reply) => {
      const file = await request.file();
      if (!file) return fastify.httpErrors.badRequest('No file provided');

      const { ticketId, findingId, description } = request.query;
      const datePrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
      const relativePath = join(datePrefix, `${Date.now()}-${file.filename}`);
      const fullPath = join(storagePath, relativePath);

      await mkdir(dirname(fullPath), { recursive: true });
      await pipeline(file.file, createWriteStream(fullPath));

      const artifact = await fastify.db.artifact.create({
        data: {
          ticketId: ticketId ?? null,
          findingId: findingId ?? null,
          filename: file.filename,
          mimeType: file.mimetype,
          sizeBytes: file.file.bytesRead,
          storagePath: relativePath,
          description: description ?? null,
        },
      });

      reply.code(201);
      return artifact;
    },
  );
}

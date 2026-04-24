import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

export async function artifactRoutes(fastify: FastifyInstance, opts: { config: Config }): Promise<void> {
  const storagePath = opts.config.ARTIFACT_STORAGE_PATH;

  fastify.get<{ Params: { ticketId: string } }>('/api/tickets/:ticketId/artifacts', async (request) => {
    const scope = await resolveClientScope(request);
    // Verify the ticket exists and is in the caller's scope before listing its artifacts.
    const ticket = await fastify.db.ticket.findFirst({
      where: { id: request.params.ticketId, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');

    const artifacts = await fastify.db.artifact.findMany({
      where: { ticketId: request.params.ticketId },
      orderBy: { createdAt: 'desc' },
    });
    return artifacts;
  });

  fastify.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request) => {
    const scope = await resolveClientScope(request);
    // Load the artifact with its ticket's clientId so we can enforce scope.
    const artifact = await fastify.db.artifact.findFirst({
      where: {
        id: request.params.id,
        OR: [
          // Artifact is ticket-linked — enforce ticket scope.
          { ticket: { ...scopeToWhere(scope) } },
          // Artifact has no ticket (finding-only or unlinked) — allow all authenticated callers.
          { ticketId: null },
        ],
      },
    });
    if (!artifact) return fastify.httpErrors.notFound('Artifact not found');
    return artifact;
  });

  fastify.get<{ Params: { id: string } }>('/api/artifacts/:id/download', async (request, reply) => {
    const scope = await resolveClientScope(request);
    // Load the artifact with its ticket's clientId so we can enforce scope.
    const artifact = await fastify.db.artifact.findFirst({
      where: {
        id: request.params.id,
        OR: [
          { ticket: { ...scopeToWhere(scope) } },
          { ticketId: null },
        ],
      },
    });
    if (!artifact) return fastify.httpErrors.notFound('Artifact not found');

    const filePath = join(storagePath, artifact.storagePath);
    const filename = artifact.filename;
    // Sanitize the ASCII fallback: strip path separators (basename), control chars,
    // quotes, and backslashes to prevent Content-Disposition header injection.
    // Non-ASCII survives via filename*=UTF-8'' (RFC 5987).
    const asciiFallback = basename(filename)
      .replace(/[\x00-\x1f\x7f"\\]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_');
    const encodedUtf8 = encodeURIComponent(filename)
      .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/\*/g, '%2A');
    reply.header('Content-Type', artifact.mimeType);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`,
    );
    return reply.send(createReadStream(filePath));
  });

  fastify.post<{ Querystring: { ticketId?: string; findingId?: string; description?: string } }>(
    '/api/artifacts/upload',
    async (request, reply) => {
      const file = await request.file();
      if (!file) return fastify.httpErrors.badRequest('No file provided');

      // ticketId, findingId, and description are passed as querystring params so
      // they can accompany a multipart/form-data upload without a JSON body.
      const { ticketId, findingId, description } = request.query;

      // Scope checks: resolve once if either parent is provided.
      if (ticketId || findingId) {
        const scope = await resolveClientScope(request);

        // If a ticketId is provided, verify the caller has scope over that ticket
        // before accepting the upload. Returns 404 to prevent ticket-ID enumeration.
        if (ticketId) {
          const ticket = await fastify.db.ticket.findFirst({
            where: { id: ticketId, ...scopeToWhere(scope) },
            select: { id: true, clientId: true },
          });
          if (!ticket) return fastify.httpErrors.notFound('Ticket not found');
        }

        // If a findingId is provided, verify the caller has scope over that finding
        // before accepting the upload. Returns 404 to prevent finding-ID enumeration.
        // Findings are scoped via their system's clientId.
        if (findingId) {
          const finding = await fastify.db.finding.findFirst({
            where: { id: findingId, system: scopeToWhere(scope) },
            select: { id: true },
          });
          if (!finding) return fastify.httpErrors.notFound('Finding not found');
        }
      }

      // Sanitize the filename: extract the basename (strips any path separators the
      // client may have embedded), then restrict to safe characters to prevent
      // path-traversal when the name is later joined into ARTIFACT_STORAGE_PATH.
      const sanitizedFilename =
        basename(file.filename.replaceAll('\\', '/'))
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .replace(/^\.+/, '') || 'upload';

      const datePrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
      const relativePath = join(datePrefix, `${Date.now()}-${sanitizedFilename}`);
      const fullPath = join(storagePath, relativePath);

      await mkdir(dirname(fullPath), { recursive: true });
      await pipeline(file.file, createWriteStream(fullPath));

      const artifact = await fastify.db.artifact.create({
        data: {
          ticketId: ticketId ?? null,
          findingId: findingId ?? null,
          filename: sanitizedFilename,
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

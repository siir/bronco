import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Prisma } from '@bronco/db';
import { inferSchemaFromHeadTail } from '@bronco/shared-utils';
import type { Config } from '../config.js';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

/** Fields projected on Artifact rows returned by the list/get endpoints. */
const ARTIFACT_SELECT = {
  id: true,
  ticketId: true,
  findingId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  storagePath: true,
  description: true,
  createdAt: true,
  // Phase 1 enrichment fields
  kind: true,
  displayName: true,
  source: true,
  addedByPersonId: true,
  addedBySystem: true,
  originatingEventId: true,
  originatingEventType: true,
  schemaJson: true,
  // Person join: project only safe fields (id, name, email — no passwordHash etc.)
  addedByPerson: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} as const;

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
      select: ARTIFACT_SELECT,
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
      select: ARTIFACT_SELECT,
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
      select: {
        storagePath: true,
        filename: true,
        mimeType: true,
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

  fastify.get<{ Params: { id: string } }>('/api/artifacts/:id/content', async (request, reply) => {
    const scope = await resolveClientScope(request);
    // Same scope check as /download — but serve with Content-Disposition: inline so
    // browsers preview viewable content (text / json / images / pdf) instead of saving.
    const artifact = await fastify.db.artifact.findFirst({
      where: {
        id: request.params.id,
        OR: [
          { ticket: { ...scopeToWhere(scope) } },
          { ticketId: null },
        ],
      },
      select: {
        storagePath: true,
        filename: true,
        mimeType: true,
      },
    });
    if (!artifact) return fastify.httpErrors.notFound('Artifact not found');

    const filePath = join(storagePath, artifact.storagePath);
    const filename = artifact.filename;
    const asciiFallback = basename(filename)
      .replace(/[\x00-\x1f\x7f"\\]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_');
    const encodedUtf8 = encodeURIComponent(filename)
      .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/\*/g, '%2A');
    reply.header('Content-Type', artifact.mimeType);
    reply.header(
      'Content-Disposition',
      `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`,
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
      // The artifact kind is hardcoded to OPERATOR_UPLOAD — callers cannot mislabel
      // operator uploads as PROBE_RESULT / EMAIL_ATTACHMENT / MCP_TOOL_RESULT (those
      // kinds are written exclusively by their respective worker pipelines).
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

      // Resolve the operator's Person ID from the JWT (present for authenticated callers).
      const callerPersonId = request.user?.personId ?? null;

      // Best-effort schema inference for text/json/xml/csv operator uploads. Binaries leave schemaJson null.
      const mt = (file.mimetype || '').toLowerCase();
      const isText = mt.startsWith('text/') || mt.includes('json') || mt.includes('xml') || mt.includes('csv');
      let schemaJson: Prisma.InputJsonValue | undefined;
      if (isText) {
        try {
          const buf = await readFile(fullPath);
          const text = buf.toString('utf-8');
          const head = text.slice(0, 2048);
          const tail = text.length > 2048 ? text.slice(-512) : '';
          const inferred = inferSchemaFromHeadTail(head, tail, file.mimetype || null);
          schemaJson = inferred as unknown as Prisma.InputJsonValue;
        } catch (err) {
          fastify.log.warn({ err, filename: sanitizedFilename }, 'Operator-upload schema inference failed — continuing without schema');
        }
      }

      const artifact = await fastify.db.artifact.create({
        data: {
          ticketId: ticketId ?? null,
          findingId: findingId ?? null,
          filename: sanitizedFilename,
          mimeType: file.mimetype,
          sizeBytes: file.file.bytesRead,
          storagePath: relativePath,
          description: description ?? null,
          kind: 'OPERATOR_UPLOAD',
          displayName: sanitizedFilename,
          source: 'upload',
          addedByPersonId: callerPersonId,
          addedBySystem: 'copilot-api:upload',
          ...(schemaJson !== undefined ? { schemaJson } : {}),
        },
        select: ARTIFACT_SELECT,
      });

      reply.code(201);
      return artifact;
    },
  );
}

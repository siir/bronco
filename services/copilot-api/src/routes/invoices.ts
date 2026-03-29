import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Prisma } from '@bronco/db';
import { aggregateDailyUsage, generateInvoicePdf, nextInvoiceNumber, ensureInvoiceDir } from '../services/invoice-generator.js';

interface InvoiceRouteOpts {
  invoiceStoragePath: string;
}

export async function invoiceRoutes(fastify: FastifyInstance, opts: InvoiceRouteOpts): Promise<void> {
  const { invoiceStoragePath } = opts;
  ensureInvoiceDir(invoiceStoragePath);

  // GET /api/clients/:id/invoices — list invoices for client
  fastify.get<{ Params: { id: string } }>('/api/clients/:id/invoices', async (request) => {
    const rows = await fastify.db.invoice.findMany({
      where: { clientId: request.params.id },
      orderBy: { invoiceNumber: 'desc' },
      select: {
        id: true, invoiceNumber: true, periodStart: true, periodEnd: true,
        totalBaseCostUsd: true, totalBilledCostUsd: true, totalInputTokens: true,
        totalOutputTokens: true, requestCount: true, markupPercent: true,
        status: true, pdfPath: true, createdAt: true,
      },
    });
    return rows.map(({ pdfPath, ...rest }) => ({ ...rest, hasPdf: !!pdfPath }));
  });

  // POST /api/clients/:id/invoices/generate — generate a new invoice
  fastify.post<{
    Params: { id: string };
    Body: { periodStart: string; periodEnd: string; finalize?: boolean };
  }>('/api/clients/:id/invoices/generate', async (request, reply) => {
    const client = await fastify.db.client.findUnique({
      where: { id: request.params.id },
      select: { name: true, billingMarkupPercent: true },
    });
    if (!client) return reply.code(404).send({ error: 'Client not found' });

    const periodStart = new Date(request.body.periodStart);
    // Parse periodEnd as UTC end-of-day to avoid timezone ambiguity: "2026-03-31" parsed with
    // new Date() becomes UTC midnight, which setHours() then shifts into local time on non-UTC
    // servers. Using an explicit UTC end-of-day timestamp avoids this.
    const periodEnd = new Date(`${request.body.periodEnd}T23:59:59.999Z`);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      return reply.code(400).send({ error: 'Invalid periodStart or periodEnd' });
    }
    if (periodEnd <= periodStart) {
      return reply.code(400).send({ error: 'periodEnd must be after periodStart' });
    }

    const markupMultiplier = Number(client.billingMarkupPercent);
    const usageData = await aggregateDailyUsage(fastify.db, request.params.id, periodStart, periodEnd, markupMultiplier);

    if (usageData.requestCount === 0) {
      return reply.code(422).send({ error: 'No usage in the specified period \u2014 invoice not generated' });
    }

    let invoice: Awaited<ReturnType<typeof fastify.db.invoice.create>> | undefined;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const last = await fastify.db.invoice.findFirst({
        where: { clientId: request.params.id },
        orderBy: { invoiceNumber: 'desc' },
        select: { invoiceNumber: true },
      });
      const invoiceNumber = nextInvoiceNumber(last?.invoiceNumber ?? null);

      const finalFileName = `invoice-${request.params.id}-${invoiceNumber}.pdf`;
      const finalPdfPath = join(invoiceStoragePath, finalFileName);
      await generateInvoicePdf({
        clientName: client.name,
        invoiceNumber,
        markupMultiplier,
        ...usageData,
      }, finalPdfPath);

      try {
        invoice = await fastify.db.invoice.create({
          data: {
            clientId: request.params.id,
            invoiceNumber,
            periodStart,
            periodEnd,
            totalBaseCostUsd: usageData.totalBaseCostUsd,
            totalBilledCostUsd: usageData.totalBilledCostUsd,
            totalInputTokens: usageData.totalInputTokens,
            totalOutputTokens: usageData.totalOutputTokens,
            requestCount: usageData.requestCount,
            markupPercent: markupMultiplier,
            pdfPath: finalPdfPath,
            status: request.body.finalize ? 'final' : 'draft',
          },
        });
        break;
      } catch (err) {
        // Clean up the PDF we just generated before retrying with a new invoice number
        await unlink(finalPdfPath).catch(() => { /* non-fatal */ });
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
          continue;
        }
        throw err;
      }
    }

    reply.code(201);
    return invoice!
  });

  // GET /api/clients/:id/invoices/:invoiceId/download — stream PDF
  fastify.get<{ Params: { id: string; invoiceId: string } }>(
    '/api/clients/:id/invoices/:invoiceId/download',
    async (request, reply) => {
      const invoice = await fastify.db.invoice.findFirst({
        where: { id: request.params.invoiceId, clientId: request.params.id },
      });
      if (!invoice || !invoice.pdfPath) return reply.code(404).send({ error: 'Invoice or PDF not found' });
      if (!existsSync(invoice.pdfPath)) return reply.code(404).send({ error: 'PDF file not found on disk' });

      const num = String(invoice.invoiceNumber).padStart(4, '0');
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="invoice-${num}.pdf"`);
      return reply.send(createReadStream(invoice.pdfPath));
    },
  );

  // PATCH /api/clients/:id/invoices/:invoiceId — update status (draft → final)
  fastify.patch<{ Params: { id: string; invoiceId: string }; Body: { status: string } }>(
    '/api/clients/:id/invoices/:invoiceId',
    async (request, reply) => {
      const { status } = request.body;
      if (status !== 'draft' && status !== 'final') {
        return reply.code(400).send({ error: 'status must be "draft" or "final"' });
      }
      const existing = await fastify.db.invoice.findFirst({
        where: { id: request.params.invoiceId, clientId: request.params.id },
        select: { id: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Invoice not found' });
      return fastify.db.invoice.update({
        where: { id: existing.id },
        data: { status },
      });
    },
  );

  // DELETE /api/clients/:id/invoices/:invoiceId
  fastify.delete<{ Params: { id: string; invoiceId: string } }>(
    '/api/clients/:id/invoices/:invoiceId',
    async (request, reply) => {
      const invoice = await fastify.db.invoice.findFirst({
        where: { id: request.params.invoiceId, clientId: request.params.id },
      });
      if (!invoice) return reply.code(404).send({ error: 'Invoice not found' });
      if (invoice.pdfPath && existsSync(invoice.pdfPath)) {
        await unlink(invoice.pdfPath).catch(() => { /* non-fatal */ });
      }
      await fastify.db.invoice.delete({ where: { id: invoice.id } });
      return reply.code(204).send();
    },
  );
}

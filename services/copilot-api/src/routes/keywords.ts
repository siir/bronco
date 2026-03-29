import type { FastifyInstance } from 'fastify';
import { KeywordCategory } from '@bronco/shared-types';

const VALID_CATEGORIES = new Set<string>(Object.values(KeywordCategory));

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function keywordRoutes(fastify: FastifyInstance): Promise<void> {
  // --- List all keywords (grouped by category for dropdown) ---
  fastify.get<{
    Querystring: { category?: string; search?: string };
  }>('/api/keywords', async (request) => {
    const { category, search } = request.query;
    return fastify.db.promptKeyword.findMany({
      where: {
        ...(category && { category }),
        ...(search && {
          OR: [
            { token: { contains: search, mode: 'insensitive' as const } },
            { label: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        }),
      },
      orderBy: [{ category: 'asc' }, { token: 'asc' }],
    });
  });

  // --- Get single keyword ---
  fastify.get<{ Params: { id: string } }>('/api/keywords/:id', async (request) => {
    const keyword = await fastify.db.promptKeyword.findUnique({
      where: { id: request.params.id },
    });
    if (!keyword) return fastify.httpErrors.notFound('Keyword not found');
    return keyword;
  });

  // --- Create keyword ---
  fastify.post<{
    Body: {
      token: string;
      label: string;
      description: string;
      sampleValue?: string;
      category: string;
    };
  }>('/api/keywords', async (request, reply) => {
    const { token, label, description, category } = request.body;
    if (!token?.trim() || !label?.trim() || !description?.trim()) {
      return fastify.httpErrors.badRequest('token, label, and description are required and cannot be empty.');
    }
    if (!VALID_CATEGORIES.has(category)) {
      return fastify.httpErrors.badRequest(
        `Invalid category "${category}". Must be one of: ${[...VALID_CATEGORIES].join(', ')}.`,
      );
    }

    try {
      const keyword = await fastify.db.promptKeyword.create({
        data: request.body,
      });
      reply.code(201);
      return keyword;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A keyword with this token already exists');
      }
      throw err;
    }
  });

  // --- Update keyword ---
  fastify.patch<{
    Params: { id: string };
    Body: {
      token?: string;
      label?: string;
      description?: string;
      sampleValue?: string | null;
      category?: string;
    };
  }>('/api/keywords/:id', async (request) => {
    const { category } = request.body;
    if (category !== undefined && !VALID_CATEGORIES.has(category)) {
      return fastify.httpErrors.badRequest(
        `Invalid category "${category}". Must be one of: ${[...VALID_CATEGORIES].join(', ')}.`,
      );
    }

    try {
      return await fastify.db.promptKeyword.update({
        where: { id: request.params.id },
        data: request.body,
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Keyword not found');
      }
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A keyword with this token already exists');
      }
      throw err;
    }
  });

  // --- Seed default keywords (idempotent) ---
  fastify.post('/api/keywords/seed', async () => {
    const defaults: Array<{
      token: string;
      label: string;
      description: string;
      sampleValue: string;
      category: string;
    }> = [
      // TICKET
      { token: 'ticket_id', label: 'Ticket ID', description: 'Unique ticket identifier', sampleValue: 'TK-00042', category: 'TICKET' },
      { token: 'ticket_subject', label: 'Ticket Subject', description: 'Subject line of the ticket', sampleValue: 'Slow query on Orders table', category: 'TICKET' },
      { token: 'ticket_priority', label: 'Ticket Priority', description: 'Priority level of the ticket', sampleValue: 'HIGH', category: 'TICKET' },
      { token: 'ticket_status', label: 'Ticket Status', description: 'Current status of the ticket', sampleValue: 'OPEN', category: 'TICKET' },
      { token: 'ticket_category', label: 'Ticket Category', description: 'Category classification of the ticket', sampleValue: 'DATABASE_PERF', category: 'TICKET' },
      { token: 'ticket_description', label: 'Ticket Description', description: 'Full description body of the ticket', sampleValue: 'Users reporting 30s+ load times...', category: 'TICKET' },
      // EMAIL
      { token: 'email_from', label: 'Email From', description: 'Sender address of the inbound email', sampleValue: 'john@acme.com', category: 'EMAIL' },
      { token: 'email_subject', label: 'Email Subject', description: 'Subject line of the email', sampleValue: 'RE: Database performance issue', category: 'EMAIL' },
      { token: 'email_body', label: 'Email Body', description: 'Plain-text body of the email', sampleValue: 'Hi, we noticed the reports dashboard...', category: 'EMAIL' },
      { token: 'email_thread_count', label: 'Thread Count', description: 'Number of emails in the thread', sampleValue: '3', category: 'EMAIL' },
      // DATABASE
      { token: 'database_name', label: 'Database Name', description: 'Name of the target database', sampleValue: 'AcmeProduction', category: 'DATABASE' },
      { token: 'server_name', label: 'Server Name', description: 'Database server hostname', sampleValue: 'acme-sql-mi.database.windows.net', category: 'DATABASE' },
      { token: 'query_text', label: 'Query Text', description: 'SQL query text being analyzed', sampleValue: 'SELECT * FROM Orders WHERE...', category: 'DATABASE' },
      { token: 'execution_plan', label: 'Execution Plan', description: 'Query execution plan XML or text', sampleValue: '<ShowPlanXML...>', category: 'DATABASE' },
      // CODE
      { token: 'file_path', label: 'File Path', description: 'Path to the source file being reviewed', sampleValue: 'src/api/routes/orders.ts', category: 'CODE' },
      { token: 'code_snippet', label: 'Code Snippet', description: 'Relevant code excerpt', sampleValue: 'function getOrders() { ... }', category: 'CODE' },
      { token: 'repo_name', label: 'Repository Name', description: 'Name of the code repository', sampleValue: 'acme-backend', category: 'CODE' },
      { token: 'branch_name', label: 'Branch Name', description: 'Git branch being worked on', sampleValue: 'fix/12-api-validation', category: 'CODE' },
      // DEVOPS
      { token: 'work_item_id', label: 'Work Item ID', description: 'Azure DevOps work item number', sampleValue: '1234', category: 'DEVOPS' },
      { token: 'work_item_title', label: 'Work Item Title', description: 'Title of the DevOps work item', sampleValue: 'Add retry logic to sync endpoint', category: 'DEVOPS' },
      { token: 'assigned_to', label: 'Assigned To', description: 'Person assigned to the work item', sampleValue: 'siir@example.com', category: 'DEVOPS' },
      // GENERAL
      { token: 'client_name', label: 'Client Name', description: 'Display name of the client', sampleValue: 'Acme Corp', category: 'GENERAL' },
      { token: 'client_short_code', label: 'Client Short Code', description: 'Short identifier for the client', sampleValue: 'ACME', category: 'GENERAL' },
      { token: 'current_date', label: 'Current Date', description: 'Today\'s date in ISO format', sampleValue: '2026-03-01', category: 'GENERAL' },
      { token: 'operator_name', label: 'Operator Name', description: 'Name of the system operator', sampleValue: 'Siir', category: 'GENERAL' },
    ];

    const validDefaults = defaults.filter(d => VALID_CATEGORIES.has(d.category));
    const tokens = validDefaults.map(d => d.token);
    const existing = await fastify.db.promptKeyword.findMany({
      where: { token: { in: tokens } },
    });
    const existingByToken = new Map(existing.map(kw => [kw.token, kw]));

    const results = [];
    let seeded = 0;
    let skipped = 0;
    for (const d of validDefaults) {
      const prev = existingByToken.get(d.token);
      if (prev) {
        skipped++;
        results.push(prev);
        continue;
      }
      try {
        const kw = await fastify.db.promptKeyword.create({ data: d });
        seeded++;
        results.push(kw);
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          skipped++;
        } else {
          throw err;
        }
      }
    }
    return { seeded, skipped, keywords: results };
  });

  // --- Delete keyword ---
  fastify.delete<{ Params: { id: string } }>('/api/keywords/:id', async (request, reply) => {
    // Check if any active prompts reference this keyword
    const keyword = await fastify.db.promptKeyword.findUnique({
      where: { id: request.params.id },
    });
    if (!keyword) return fastify.httpErrors.notFound('Keyword not found');

    const referencingOverrides = await fastify.db.promptOverride.count({
      where: {
        content: { contains: `{{${keyword.token}}}`, mode: 'insensitive' as const },
        isActive: true,
      },
    });
    if (referencingOverrides > 0) {
      return fastify.httpErrors.conflict(
        `Cannot delete keyword "${keyword.token}" — referenced by ${referencingOverrides} active override(s). ` +
        'Remove it from overrides first, or deactivate those overrides.',
      );
    }

    await fastify.db.promptKeyword.delete({
      where: { id: request.params.id },
    });
    reply.code(204);
  });
}

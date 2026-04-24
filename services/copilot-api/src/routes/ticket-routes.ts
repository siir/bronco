import type { FastifyInstance } from 'fastify';
import { Prisma } from '@bronco/db';
import type { PrismaClient, PrismaRouteStepType, PrismaRouteType } from '@bronco/db';
import { TaskType, TicketCategory, TicketSource, RouteStepType, RouteType } from '@bronco/shared-types';
import type { RouteStepTypeInfo } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { resolveClientScope } from '../plugins/client-scope.js';
import type { ClientScope } from '../plugins/client-scope.js';

const VALID_CATEGORIES = new Set<string>(Object.values(TicketCategory));
const VALID_STEP_TYPES = new Set<string>(Object.values(RouteStepType));
const VALID_TASK_TYPES = new Set<string>(Object.values(TaskType));
const VALID_SOURCES = new Set<string>(Object.values(TicketSource));
const VALID_ROUTE_TYPES = new Set<string>(Object.values(RouteType));

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

function prismaP2002Target(err: unknown): string[] {
  if (isPrismaError(err, 'P2002')) {
    const meta = (err as { meta?: { target?: string | string[] } }).meta;
    const target = meta?.target;
    if (Array.isArray(target)) return target;
    if (typeof target === 'string' && target.length > 0) return [target];
  }
  return [];
}

/** Registry of built-in step types with metadata for the UI. */
const STEP_TYPE_INFO: RouteStepTypeInfo[] = [
  {
    type: RouteStepType.RESOLVE_THREAD,
    name: 'Resolve Thread',
    description: 'Determines whether an email is a new ticket or a reply to an existing thread. Replies are appended to the existing ticket and downstream creation steps are skipped.',
    phase: 'ingestion',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.SUMMARIZE_EMAIL,
    name: 'Summarize Email',
    description: 'Summarizes the inbound email into 2-3 concise bullet points.',
    phase: 'ingestion',
    defaultTaskType: TaskType.SUMMARIZE,
    defaultPromptKey: 'imap.summarize.system',
  },
  {
    type: RouteStepType.CATEGORIZE,
    name: 'Categorize Ticket',
    description: 'Classifies the ticket into a category (DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, etc.).',
    phase: 'ingestion',
    defaultTaskType: TaskType.CATEGORIZE,
    defaultPromptKey: 'imap.categorize.system',
  },
  {
    type: RouteStepType.TRIAGE_PRIORITY,
    name: 'Triage Priority',
    description: 'Assesses the ticket priority (LOW, MEDIUM, HIGH, CRITICAL) based on urgency indicators.',
    phase: 'ingestion',
    defaultTaskType: TaskType.TRIAGE,
    defaultPromptKey: 'imap.triage.system',
  },
  {
    type: RouteStepType.DRAFT_RECEIPT,
    name: 'Draft Receipt Email',
    description: 'Generates and sends a professional receipt confirmation email to the requester.',
    phase: 'ingestion',
    defaultTaskType: TaskType.DRAFT_EMAIL,
    defaultPromptKey: 'imap.draft-receipt.system',
  },
  {
    type: RouteStepType.GENERATE_TITLE,
    name: 'Generate Title',
    description: 'Generates an improved ticket title from the email content (max 80 chars).',
    phase: 'ingestion',
    defaultTaskType: TaskType.GENERATE_TITLE,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.LOAD_CLIENT_CONTEXT,
    name: 'Load Client Context',
    description: 'Loads per-client operational knowledge (context, playbooks, tool guidance) from client memory entries. Injects relevant knowledge into the pipeline for downstream analysis steps.',
    phase: 'analysis',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.LOAD_ENVIRONMENT_CONTEXT,
    name: 'Load Environment Context',
    description: 'Loads the environment\'s operationalInstructions and injects them into the pipeline context for downstream analysis steps. Only runs if the ticket is scoped to an environment.',
    phase: 'analysis',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.EXTRACT_FACTS,
    name: 'Extract Facts',
    description: 'Extracts structured facts (error messages, file paths, services, keywords) from the email.',
    phase: 'analysis',
    defaultTaskType: TaskType.EXTRACT_FACTS,
    defaultPromptKey: 'imap.extract-facts.system',
  },
  {
    type: RouteStepType.GATHER_REPO_CONTEXT,
    name: 'Gather Repository Context',
    description: 'Clones/pulls client git repositories and searches for relevant code based on extracted facts.',
    phase: 'analysis',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.GATHER_DB_CONTEXT,
    name: 'Gather Database Context',
    description: 'Queries the MCP database server for health, blocking tree, and wait stats if the issue is database-related.',
    phase: 'analysis',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.DEEP_ANALYSIS,
    name: 'Deep Analysis',
    description: 'Runs deep AI analysis of the issue using all gathered context (code, database, email). Produces root cause, affected components, recommended fix, and risk assessment.',
    phase: 'analysis',
    defaultTaskType: TaskType.DEEP_ANALYSIS,
    defaultPromptKey: 'imap.deep-analysis.system',
  },
  {
    type: RouteStepType.AGENTIC_ANALYSIS,
    name: 'Agentic Analysis',
    description: 'AI autonomously investigates the ticket using available MCP tools and code repositories, deciding which tools to call in a multi-turn loop. Configurable via step config: maxIterations (default 10), systemPromptOverride (appended to default prompt).',
    phase: 'analysis',
    defaultTaskType: TaskType.DEEP_ANALYSIS,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.DRAFT_FINDINGS_EMAIL,
    name: 'Draft Findings Email',
    description: 'Generates and sends a professional email sharing analysis findings with the requester.',
    phase: 'analysis',
    defaultTaskType: TaskType.DRAFT_EMAIL,
    defaultPromptKey: 'imap.draft-analysis-email.system',
  },
  {
    type: RouteStepType.SUGGEST_NEXT_STEPS,
    name: 'Suggest Next Steps',
    description: 'Suggests next steps as advisory recommendations (status changes, priority adjustments, code fix triggers).',
    phase: 'analysis',
    defaultTaskType: TaskType.SUGGEST_NEXT_STEPS,
    defaultPromptKey: 'imap.suggest-next-steps.system',
  },
  {
    type: RouteStepType.UPDATE_TICKET_SUMMARY,
    name: 'Update Ticket Summary',
    description: 'Generates a comprehensive ticket summary from the full event history and stores it on the ticket.',
    phase: 'analysis',
    defaultTaskType: TaskType.SUMMARIZE_TICKET,
    defaultPromptKey: 'imap.summarize-ticket.system',
  },
  {
    type: RouteStepType.NOTIFY_OPERATOR,
    name: 'Notify Operator',
    description: 'Sends a notification email to a configured address (not a reply to the ticket sender). Configure emailTo in step config.',
    phase: 'analysis',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.DISPATCH_TO_ROUTE,
    name: 'Dispatch to Route',
    description: 'Re-resolves the ticket route using the now-known category and dispatches to a specialized route if one matches. Enables triage routes to hand off to category-specific analysis routes.',
    phase: 'dispatch',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.ADD_FOLLOWER,
    name: 'Add Follower',
    description: 'Adds a contact as a follower to the ticket. Configure email (exact address) or emailDomain (match all contacts with that domain) and optional followerType (REQUESTER or FOLLOWER, default FOLLOWER) in step config.',
    phase: 'ingestion',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.CREATE_TICKET,
    name: 'Create Ticket',
    description: 'Creates the ticket record from accumulated ingestion state (title, summary, category, priority). Must appear in ingestion routes — skipped in analysis routes where the ticket already exists.',
    phase: 'ingestion',
    defaultTaskType: null,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.CUSTOM_AI_QUERY,
    name: 'Custom AI Query',
    description: 'Runs a custom AI prompt with selectable context sources. Can include prior pipeline context (client, code, DB, facts) and/or make fresh MCP tool calls and repo searches. Result is recorded as a ticket event.',
    phase: 'analysis',
    defaultTaskType: TaskType.CUSTOM_AI_QUERY,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.UPDATE_ANALYSIS,
    name: 'Update Analysis',
    description: 'Incremental analysis triggered by a reply to an already-analyzed ticket. Compares the new information against prior findings and reports only what changed, what gaps were filled, and what open questions were answered.',
    phase: 'analysis',
    defaultTaskType: TaskType.DEEP_ANALYSIS,
    defaultPromptKey: null,
  },
  {
    type: RouteStepType.DETECT_TOOL_GAPS,
    name: 'Detect Tool Gaps',
    description: 'Scans the completed analysis for capability gaps the agent did not surface inline. Upserts detected gaps into the ToolRequest registry with source=POST_HOC_DETECTION. Typically placed at end of an analysis route.',
    phase: 'analysis',
    defaultTaskType: TaskType.DETECT_TOOL_GAPS,
    defaultPromptKey: 'detect-tool-gaps.system',
  },
];

/** Map from step type → phase for mismatch detection. */
const STEP_PHASE_BY_TYPE = new Map<RouteStepType, RouteStepTypeInfo['phase']>(
  STEP_TYPE_INFO.map((info) => [info.type, info.phase]),
);

/**
 * Valid step phases for each route type.
 *
 * INGESTION routes: ingestion-phase steps only (the pipeline creates the ticket).
 * ANALYSIS routes: analysis + dispatch phase steps, plus ingestion-phase steps that
 *   are valid in an analysis context (e.g. SUMMARIZE_EMAIL, CATEGORIZE, ADD_FOLLOWER).
 *   CREATE_TICKET is the only ingestion-phase step that is meaningless in ANALYSIS
 *   routes (the ticket already exists) and is handled as an explicit exception below.
 */
const VALID_PHASES_BY_ROUTE_TYPE: Record<RouteType, Set<RouteStepTypeInfo['phase']>> = {
  INGESTION: new Set(['ingestion']),
  ANALYSIS: new Set(['ingestion', 'analysis', 'dispatch']),
};

/**
 * Step types that are phase-compatible with ANALYSIS routes per the phase map, but are
 * functionally meaningless there (the ticket already exists). Warn explicitly for these.
 */
const ANALYSIS_INCOMPATIBLE_STEP_TYPES = new Set<RouteStepType>([RouteStepType.CREATE_TICKET, RouteStepType.RESOLVE_THREAD]);

/** Build a phase mismatch warning if the step type is incompatible with the route type. */
function checkStepPhaseMismatch(stepType: RouteStepType, routeType: RouteType): string | null {
  if (routeType === RouteType.ANALYSIS && ANALYSIS_INCOMPATIBLE_STEP_TYPES.has(stepType)) {
    return `Step type "${stepType}" creates a new ticket and is not appropriate for an ANALYSIS route where the ticket already exists. It will be silently skipped at runtime.`;
  }
  const stepPhase = STEP_PHASE_BY_TYPE.get(stepType);
  const validPhases = VALID_PHASES_BY_ROUTE_TYPE[routeType];
  if (!stepPhase || !validPhases) return null;
  if (!validPhases.has(stepPhase)) {
    return `Step type "${stepType}" (phase: ${stepPhase}) is not appropriate for a ${routeType} route. It will be silently skipped at runtime.`;
  }
  return null;
}

const VALID_DISPATCH_MODES = new Set(['auto', 'pin', 'rules']);
const VALID_FALLBACKS = new Set(['auto', 'stop']);

async function validateDispatchConfig(
  db: PrismaClient,
  config: Record<string, unknown>,
): Promise<string | null> {
  const mode = config['mode'];
  if (!mode || !VALID_DISPATCH_MODES.has(mode as string)) {
    return `Invalid dispatch mode "${mode}". Must be one of: auto, pin, rules`;
  }

  if (mode === 'pin') {
    const targetId = config['targetRouteId'];
    if (!targetId || typeof targetId !== 'string') {
      return 'targetRouteId is required when mode is pin';
    }
    const target = await db.ticketRoute.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) return `Target route "${targetId}" not found`;
  }

  if (mode === 'rules') {
    const rules = config['rules'];
    if (!Array.isArray(rules) || rules.length === 0) {
      return 'rules array is required and must not be empty when mode is rules';
    }
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as Record<string, unknown>;
      if (!rule['category'] || !VALID_CATEGORIES.has(rule['category'] as string)) {
        return `Rule ${i}: invalid category "${rule['category']}"`;
      }
      if (!rule['targetRouteId'] || typeof rule['targetRouteId'] !== 'string') {
        return `Rule ${i}: targetRouteId is required`;
      }
      const target = await db.ticketRoute.findUnique({ where: { id: rule['targetRouteId'] as string }, select: { id: true } });
      if (!target) return `Rule ${i}: target route "${rule['targetRouteId']}" not found`;
    }

    const fallback = config['fallback'];
    if (fallback && !VALID_FALLBACKS.has(fallback as string)) {
      return `Invalid fallback "${fallback}". Must be one of: auto, stop`;
    }
  }

  return null;
}

const VALID_MCP_TOOL_NAMES = new Set([
  'run_query', 'inspect_schema', 'list_indexes',
  'get_blocking_tree', 'get_wait_stats', 'get_database_health',
]);

function validateCustomAiQueryConfig(config: Record<string, unknown>): string | null {
  const prompt = config['prompt'];
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return 'prompt is required for CUSTOM_AI_QUERY steps';
  }

  const mcpQueries = config['mcpQueries'];
  if (mcpQueries !== undefined && mcpQueries !== null) {
    if (!Array.isArray(mcpQueries)) return 'mcpQueries must be an array';
    for (let i = 0; i < mcpQueries.length; i++) {
      const entry = mcpQueries[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return `mcpQueries[${i}]: must be a plain object`;
      }
      const q = entry as Record<string, unknown>;
      if (!q['toolName'] || !VALID_MCP_TOOL_NAMES.has(q['toolName'] as string)) {
        return `mcpQueries[${i}]: invalid toolName "${q['toolName']}". Must be one of: ${[...VALID_MCP_TOOL_NAMES].join(', ')}`;
      }
      if (q['params'] !== undefined && q['params'] !== null) {
        if (typeof q['params'] !== 'object' || Array.isArray(q['params'])) {
          return `mcpQueries[${i}]: params must be a plain object`;
        }
      }
    }
  }

  const repoSearches = config['repoSearches'];
  if (repoSearches !== undefined && repoSearches !== null) {
    if (!Array.isArray(repoSearches)) return 'repoSearches must be an array';
    for (let i = 0; i < repoSearches.length; i++) {
      const entry = repoSearches[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return `repoSearches[${i}]: must be a plain object`;
      }
      const s = entry as Record<string, unknown>;
      const hasTerms = Array.isArray(s['searchTerms']) && s['searchTerms'].length > 0;
      const hasFiles = Array.isArray(s['filePaths']) && s['filePaths'].length > 0;
      if (!hasTerms && !hasFiles) {
        return `repoSearches[${i}]: must have at least searchTerms or filePaths`;
      }
      if (hasTerms) {
        const terms = s['searchTerms'] as unknown[];
        for (let j = 0; j < terms.length; j++) {
          if (typeof terms[j] !== 'string') {
            return `repoSearches[${i}]: searchTerms[${j}] must be a string`;
          }
        }
      }
      if (hasFiles) {
        const files = s['filePaths'] as unknown[];
        for (let j = 0; j < files.length; j++) {
          if (typeof files[j] !== 'string') {
            return `repoSearches[${i}]: filePaths[${j}] must be a string`;
          }
        }
      }
      if (s['repoName'] !== undefined && s['repoName'] !== null) {
        if (typeof s['repoName'] !== 'string' || !s['repoName'].trim()) {
          return `repoSearches[${i}]: repoName must be a non-empty string if provided`;
        }
      }
    }
  }

  return null;
}

/**
 * Build a Prisma where-clause fragment for TicketRoute that respects caller scope.
 *
 * Platform-scoped routes (clientId IS NULL) are shared infrastructure visible to all
 * authenticated callers — same pattern as ClientIntegration in integrations.ts.
 * Client-scoped routes are restricted to the caller's tenant(s).
 */
function ticketRouteScopeFilter(scope: ClientScope): Record<string, unknown> {
  if (scope.type === 'all') return {};
  if (scope.type === 'single') {
    return { OR: [{ clientId: null }, { clientId: scope.clientId }] };
  }
  // assigned
  return { OR: [{ clientId: null }, { clientId: { in: scope.clientIds } }] };
}

interface TicketRouteOpts {
  ai: AIRouter;
}

export async function ticketRouteRoutes(
  fastify: FastifyInstance,
  opts: TicketRouteOpts,
): Promise<void> {
  const { ai } = opts;

  // ─── Step Type Registry (read-only) ────────────────────────────────────

  /** List all available step types with their metadata. */
  fastify.get('/api/ticket-routes/step-types', async () => {
    return STEP_TYPE_INFO;
  });

  // ─── Dispatch Preview ───────────────────────────────────────────────

  /**
   * Preview which routes would be resolved for each TicketCategory via
   * category-match-only dispatch. Mirrors the categoryMatchOnly=true path
   * in resolveTicketRoute() in imap-worker/analyzer.ts — keep in sync.
   */
  fastify.get<{
    Querystring: { clientId?: string; routeId: string };
  }>('/api/ticket-routes/dispatch-preview', async (request) => {
    const { clientId, routeId } = request.query;
    if (!routeId) return fastify.httpErrors.badRequest('routeId is required');

    // Scope guard: if a clientId was provided, validate the caller can access it
    if (clientId) {
      const callerScope = await resolveClientScope(request);
      const inScope =
        callerScope.type === 'all' ||
        (callerScope.type === 'single' && callerScope.clientId === clientId) ||
        (callerScope.type === 'assigned' && callerScope.clientIds.includes(clientId));
      if (!inScope) return fastify.httpErrors.forbidden('clientId not in your scope');
    }

    const allCategories = Object.values(TicketCategory);

    const [clientRoutes, globalRoutes] = await Promise.all([
      clientId
        ? fastify.db.ticketRoute.findMany({
            where: { clientId, isActive: true, category: { not: null }, id: { not: routeId }, steps: { some: { isActive: true } } },
            select: { id: true, name: true, category: true },
            orderBy: { sortOrder: 'asc' },
          })
        : Promise.resolve([]),
      fastify.db.ticketRoute.findMany({
        where: { clientId: null, isActive: true, category: { not: null }, id: { not: routeId }, steps: { some: { isActive: true } } },
        select: { id: true, name: true, category: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    const clientMap = new Map<string, { routeId: string; routeName: string }>();
    for (const r of clientRoutes) {
      if (r.category && !clientMap.has(r.category)) {
        clientMap.set(r.category, { routeId: r.id, routeName: r.name });
      }
    }
    const globalMap = new Map<string, { routeId: string; routeName: string }>();
    for (const r of globalRoutes) {
      if (r.category && !globalMap.has(r.category)) {
        globalMap.set(r.category, { routeId: r.id, routeName: r.name });
      }
    }

    const categories = allCategories.map((cat) => {
      const clientMatch = clientMap.get(cat);
      if (clientMatch) {
        return { category: cat, routeId: clientMatch.routeId, routeName: clientMatch.routeName, clientScoped: true };
      }
      const globalMatch = globalMap.get(cat);
      if (globalMatch) {
        return { category: cat, routeId: globalMatch.routeId, routeName: globalMatch.routeName, clientScoped: false };
      }
      return { category: cat, routeId: null, routeName: null, clientScoped: false };
    });

    return { categories };
  });

  // ─── List routes ───────────────────────────────────────────────────────

  fastify.get<{
    Querystring: { category?: string; clientId?: string; isActive?: string; routeType?: string };
  }>('/api/ticket-routes', async (request) => {
    const { category, clientId, isActive, routeType } = request.query;
    if (category && !VALID_CATEGORIES.has(category)) {
      return fastify.httpErrors.badRequest(`Invalid category "${category}".`);
    }
    if (routeType && !VALID_ROUTE_TYPES.has(routeType)) {
      return fastify.httpErrors.badRequest(`Invalid routeType "${routeType}". Valid values: ${[...VALID_ROUTE_TYPES].join(', ')}`);
    }

    const callerScope = await resolveClientScope(request);
    const scopeFilter = ticketRouteScopeFilter(callerScope);

    // If a clientId filter is requested, validate it is within the caller's scope
    const effectiveClientId =
      clientId &&
      (callerScope.type === 'all' ||
        (callerScope.type === 'single' && callerScope.clientId === clientId) ||
        (callerScope.type === 'assigned' && callerScope.clientIds.includes(clientId)))
        ? clientId
        : undefined;

    return fastify.db.ticketRoute.findMany({
      where: {
        ...scopeFilter,
        ...(category && { category: category as never }),
        ...(effectiveClientId && { clientId: effectiveClientId }),
        ...(isActive !== undefined && { isActive: isActive === 'true' }),
        ...(routeType && { routeType: routeType as never }),
      },
      include: {
        steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' } },
        client: { select: { name: true, shortCode: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  });

  // ─── Get single route ─────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    '/api/ticket-routes/:id',
    async (request) => {
      const callerScope = await resolveClientScope(request);
      const scopeFilter = ticketRouteScopeFilter(callerScope);
      const route = await fastify.db.ticketRoute.findFirst({
        where: { id: request.params.id, ...scopeFilter },
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
          client: { select: { name: true, shortCode: true } },
        },
      });
      if (!route) return fastify.httpErrors.notFound('Ticket route not found');
      return route;
    },
  );

  // ─── Create route ─────────────────────────────────────────────────────

  fastify.post<{
    Body: {
      name: string;
      description?: string;
      routeType?: string;
      category?: string;
      source?: string | null;
      clientId?: string;
      isDefault?: boolean;
      sortOrder?: number;
      steps?: Array<{
        name: string;
        stepType: string;
        stepOrder: number;
        taskTypeOverride?: string;
        promptKeyOverride?: string;
        config?: Record<string, unknown>;
      }>;
    };
  }>('/api/ticket-routes', async (request, reply) => {
    const { name, description, category, isDefault, sortOrder, steps } = request.body;
    const routeType = request.body.routeType?.trim() || 'ANALYSIS';
    const rawSource = request.body.source;
    if (rawSource !== undefined && rawSource !== null && typeof rawSource !== 'string') {
      return fastify.httpErrors.badRequest('Invalid source type. Must be a string or null.');
    }
    const source = (typeof rawSource === 'string' ? rawSource.trim() || null : null) as TicketSource | null;
    const trimmedClientId = request.body.clientId?.trim() || null;

    if (!name?.trim()) {
      return fastify.httpErrors.badRequest('name is required.');
    }
    if (!VALID_ROUTE_TYPES.has(routeType)) {
      return fastify.httpErrors.badRequest(`Invalid routeType "${routeType}". Valid values: ${[...VALID_ROUTE_TYPES].join(', ')}`);
    }
    if (category && !VALID_CATEGORIES.has(category)) {
      return fastify.httpErrors.badRequest(`Invalid category "${category}".`);
    }
    if (source && !VALID_SOURCES.has(source)) {
      return fastify.httpErrors.badRequest(`Invalid source "${source}". Valid values: ${[...VALID_SOURCES].join(', ')}`);
    }

    // Scope enforcement: validate the caller is authorized for the target client.
    // Platform-scoped (null clientId) routes require 'all' scope — only ADMIN/API-key.
    const callerScope = await resolveClientScope(request);
    if (trimmedClientId === null) {
      // Platform-scoped creation restricted to admin/API-key callers
      if (callerScope.type !== 'all') {
        return fastify.httpErrors.forbidden('Creating platform-scoped routes requires admin access');
      }
    } else if (trimmedClientId !== null) {
      if (
        (callerScope.type === 'single' && callerScope.clientId !== trimmedClientId) ||
        (callerScope.type === 'assigned' && !callerScope.clientIds.includes(trimmedClientId))
      ) {
        return fastify.httpErrors.forbidden('clientId not in your scope');
      }
    }

    if (steps) {
      for (const s of steps) {
        if (!VALID_STEP_TYPES.has(s.stepType)) {
          return fastify.httpErrors.badRequest(`Invalid step type "${s.stepType}".`);
        }
        if (s.taskTypeOverride && !VALID_TASK_TYPES.has(s.taskTypeOverride)) {
          return fastify.httpErrors.badRequest(`Invalid taskTypeOverride "${s.taskTypeOverride}" in step "${s.name}".`);
        }
      }
    }

    try {
      const route = await fastify.db.ticketRoute.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
          routeType: routeType as PrismaRouteType,
          category: (category as never) ?? null,
          source,
          clientId: trimmedClientId,
          isDefault: isDefault ?? false,
          sortOrder: sortOrder ?? 0,
          steps: steps
            ? {
                create: steps.map((s) => ({
                  name: s.name,
                  stepType: s.stepType as PrismaRouteStepType,
                  stepOrder: s.stepOrder,
                  taskTypeOverride: s.taskTypeOverride || null,
                  promptKeyOverride: s.promptKeyOverride || null,
                  config: s.config ? (s.config as Prisma.InputJsonValue) : Prisma.JsonNull,
                })),
              }
            : undefined,
        },
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
          client: { select: { name: true, shortCode: true } },
        },
      });

      // Generate AI summary in the background (best-effort)
      generateRouteSummary(fastify, ai, route.id).catch((err) => {
        fastify.log.warn({ err, routeId: route.id }, 'Failed to generate route summary on create');
      });

      const warnings: string[] = [];
      if (steps) {
        for (const s of steps) {
          const w = checkStepPhaseMismatch(s.stepType as RouteStepType, routeType as RouteType);
          if (w) warnings.push(w);
        }
      }

      reply.code(201);
      return { ...route, warnings };
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        const target = prismaP2002Target(err);
        const normalizedTargets = Array.isArray(target)
          ? target.map((t) => String(t).toLowerCase())
          : [String(target).toLowerCase()];
        const hasStepOrderToken = normalizedTargets.some(
          (t) => t.includes('steporder') || t.includes('step_order'),
        );
        const hasRouteIdAndStepOrder =
          normalizedTargets.includes('routeid') && normalizedTargets.includes('steporder');
        if (hasStepOrderToken || hasRouteIdAndStepOrder) {
          return fastify.httpErrors.conflict('Duplicate stepOrder within the route steps.');
        }
        return fastify.httpErrors.conflict('A route with this name already exists for this client.');
      }
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.badRequest('Invalid clientId — client does not exist.');
      }
      throw err;
    }
  });

  // ─── Update route ─────────────────────────────────────────────────────

  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      routeType?: string;
      category?: string | null;
      source?: string | null;
      isActive?: boolean;
      isDefault?: boolean;
      sortOrder?: number;
    };
  }>('/api/ticket-routes/:id', async (request) => {
    const { name, description, category, isActive, isDefault, sortOrder } = request.body;
    const source = request.body.source;
    const routeType = request.body.routeType;

    if (routeType !== undefined && !VALID_ROUTE_TYPES.has(routeType)) {
      return fastify.httpErrors.badRequest(`Invalid routeType "${routeType}". Valid values: ${[...VALID_ROUTE_TYPES].join(', ')}`);
    }
    if (category !== undefined && category !== null && !VALID_CATEGORIES.has(category)) {
      return fastify.httpErrors.badRequest(`Invalid category "${category}".`);
    }
    if (source !== undefined && source !== null && typeof source !== 'string') {
      return fastify.httpErrors.badRequest('Invalid source type. Must be a string or null.');
    }
    const trimmedSource = source !== undefined ? ((typeof source === 'string' ? source.trim() || null : null) as TicketSource | null) : undefined;
    if (trimmedSource && !VALID_SOURCES.has(trimmedSource)) {
      return fastify.httpErrors.badRequest(`Invalid source "${trimmedSource}". Valid values: ${[...VALID_SOURCES].join(', ')}`);
    }

    // Scope guard: ensure the caller is authorized for this route's client (or platform-scoped)
    const callerScope = await resolveClientScope(request);
    const scopeFilter = ticketRouteScopeFilter(callerScope);
    const existingRoute = await fastify.db.ticketRoute.findFirst({
      where: { id: request.params.id, ...scopeFilter },
      select: { id: true, clientId: true },
    });
    if (!existingRoute) return fastify.httpErrors.notFound('Ticket route not found');
    // Platform-scoped routes can only be mutated by admin/API-key callers
    if (existingRoute.clientId === null && callerScope.type !== 'all') {
      return fastify.httpErrors.forbidden('Platform-scoped routes can only be modified by global administrators');
    }

    try {
      const route = await fastify.db.ticketRoute.update({
        where: { id: request.params.id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description: description?.trim() || null }),
          ...(routeType !== undefined && { routeType: routeType as PrismaRouteType }),
          ...(category !== undefined && { category: (category as never) ?? null }),
          ...(trimmedSource !== undefined && { source: trimmedSource }),
          ...(isActive !== undefined && { isActive }),
          ...(isDefault !== undefined && { isDefault }),
          ...(sortOrder !== undefined && { sortOrder }),
        },
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
          client: { select: { name: true, shortCode: true } },
        },
      });

      // Re-generate AI summary if any field that affects the summary changed
      if (name !== undefined || description !== undefined || category !== undefined || routeType !== undefined) {
        generateRouteSummary(fastify, ai, route.id).catch((err) => {
          fastify.log.warn({ err, routeId: route.id }, 'Failed to regenerate route summary on update');
        });
      }

      const warnings: string[] = [];
      if (routeType !== undefined) {
        for (const s of route.steps) {
          if (!s.isActive) continue;
          const w = checkStepPhaseMismatch(s.stepType as RouteStepType, routeType as RouteType);
          if (w) warnings.push(w);
        }
      }

      return { ...route, warnings };
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A route with this name already exists for this client.');
      }
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Ticket route not found');
      }
      throw err;
    }
  });

  // ─── Delete route ─────────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string } }>(
    '/api/ticket-routes/:id',
    async (request, reply) => {
      const callerScope = await resolveClientScope(request);
      const scopeFilter = ticketRouteScopeFilter(callerScope);
      const existingRoute = await fastify.db.ticketRoute.findFirst({
        where: { id: request.params.id, ...scopeFilter },
        select: { id: true, clientId: true },
      });
      if (!existingRoute) return fastify.httpErrors.notFound('Ticket route not found');
      // Platform-scoped routes can only be deleted by admin/API-key callers
      if (existingRoute.clientId === null && callerScope.type !== 'all') {
        return fastify.httpErrors.forbidden('Platform-scoped routes can only be deleted by global administrators');
      }

      try {
        await fastify.db.ticketRoute.delete({ where: { id: request.params.id } });
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('Ticket route not found');
        }
        throw err;
      }
    },
  );

  // ─── Regenerate route summary ─────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/api/ticket-routes/:id/regenerate-summary',
    async (request) => {
      const callerScope = await resolveClientScope(request);
      const scopeFilter = ticketRouteScopeFilter(callerScope);
      const route = await fastify.db.ticketRoute.findFirst({
        where: { id: request.params.id, ...scopeFilter },
        include: { steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' } } },
      });
      if (!route) return fastify.httpErrors.notFound('Ticket route not found');

      const summary = await generateRouteSummary(fastify, ai, route.id);
      return { summary };
    },
  );

  // ─── Add step to route ────────────────────────────────────────────────

  fastify.post<{
    Params: { id: string };
    Body: {
      name: string;
      stepType: string;
      stepOrder: number;
      taskTypeOverride?: string;
      promptKeyOverride?: string;
      config?: Record<string, unknown>;
    };
  }>('/api/ticket-routes/:id/steps', async (request, reply) => {
    const { name, stepType, stepOrder, taskTypeOverride, promptKeyOverride, config } = request.body;

    if (!VALID_STEP_TYPES.has(stepType)) {
      return fastify.httpErrors.badRequest(`Invalid step type "${stepType}".`);
    }
    if (taskTypeOverride && !VALID_TASK_TYPES.has(taskTypeOverride)) {
      return fastify.httpErrors.badRequest(`Invalid taskTypeOverride "${taskTypeOverride}".`);
    }

    if (stepType === RouteStepType.DISPATCH_TO_ROUTE && config) {
      const cfgErr = await validateDispatchConfig(fastify.db, config);
      if (cfgErr) return fastify.httpErrors.badRequest(cfgErr);
    }
    if (stepType === RouteStepType.CUSTOM_AI_QUERY) {
      if (!config) return fastify.httpErrors.badRequest('config is required for CUSTOM_AI_QUERY steps');
      const cfgErr = validateCustomAiQueryConfig(config);
      if (cfgErr) return fastify.httpErrors.badRequest(cfgErr);
    }

    const callerScope = await resolveClientScope(request);
    const scopeFilter = ticketRouteScopeFilter(callerScope);
    const route = await fastify.db.ticketRoute.findFirst({
      where: { id: request.params.id, ...scopeFilter },
      select: { id: true, clientId: true, routeType: true },
    });
    if (!route) return fastify.httpErrors.notFound('Ticket route not found');
    // Platform-scoped routes can only be mutated by admin/API-key callers
    if (route.clientId === null && callerScope.type !== 'all') {
      return fastify.httpErrors.forbidden('Platform-scoped routes can only be modified by global administrators');
    }

    try {
      const step = await fastify.db.ticketRouteStep.create({
        data: {
          routeId: request.params.id,
          name,
          stepType: stepType as PrismaRouteStepType,
          stepOrder,
          taskTypeOverride: taskTypeOverride || null,
          promptKeyOverride: promptKeyOverride || null,
          config: config ? (config as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });

      // Re-generate route summary since steps changed
      generateRouteSummary(fastify, ai, request.params.id).catch((err) => {
        fastify.log.warn({ err, routeId: request.params.id }, 'Failed to regenerate route summary after step add');
      });

      const warnings: string[] = [];
      const mismatchWarning = checkStepPhaseMismatch(stepType as RouteStepType, route.routeType as RouteType);
      if (mismatchWarning) warnings.push(mismatchWarning);

      reply.code(201);
      return { ...step, warnings };
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(`Step order ${stepOrder} already exists in this route.`);
      }
      throw err;
    }
  });

  // ─── Update step ──────────────────────────────────────────────────────

  fastify.patch<{
    Params: { id: string; stepId: string };
    Body: {
      name?: string;
      stepType?: string;
      stepOrder?: number;
      taskTypeOverride?: string | null;
      promptKeyOverride?: string | null;
      config?: Record<string, unknown> | null;
      isActive?: boolean;
    };
  }>('/api/ticket-routes/:id/steps/:stepId', async (request) => {
    const { name, stepType, stepOrder, taskTypeOverride, promptKeyOverride, config, isActive } = request.body;

    if (stepType && !VALID_STEP_TYPES.has(stepType)) {
      return fastify.httpErrors.badRequest(`Invalid step type "${stepType}".`);
    }
    if (taskTypeOverride && !VALID_TASK_TYPES.has(taskTypeOverride)) {
      return fastify.httpErrors.badRequest(`Invalid taskTypeOverride "${taskTypeOverride}".`);
    }

    try {
      const callerScope = await resolveClientScope(request);
      const scopeFilter = ticketRouteScopeFilter(callerScope);
      const [existing, parentRoute] = await Promise.all([
        fastify.db.ticketRouteStep.findFirst({
          where: { id: request.params.stepId, routeId: request.params.id },
          select: { id: true, stepType: true },
        }),
        fastify.db.ticketRoute.findFirst({
          where: { id: request.params.id, ...scopeFilter },
          select: { routeType: true, clientId: true },
        }),
      ]);
      if (!parentRoute || !existing) return fastify.httpErrors.notFound('Route step not found');
      // Platform-scoped routes can only be mutated by admin/API-key callers
      if (parentRoute.clientId === null && callerScope.type !== 'all') {
        return fastify.httpErrors.forbidden('Platform-scoped routes can only be modified by global administrators');
      }

      const effectiveStepType = stepType ?? existing.stepType;
      if (effectiveStepType === RouteStepType.DISPATCH_TO_ROUTE && config) {
        const cfgErr = await validateDispatchConfig(fastify.db, config);
        if (cfgErr) return fastify.httpErrors.badRequest(cfgErr);
      }
      if (effectiveStepType === RouteStepType.CUSTOM_AI_QUERY) {
        // Require non-null config when the step type is (or is being changed to) CUSTOM_AI_QUERY.
        // This prevents persisting an invalid step that the analyzer would silently skip.
        if (!config) {
          return fastify.httpErrors.badRequest('config is required for CUSTOM_AI_QUERY steps');
        }
        const cfgErr = validateCustomAiQueryConfig(config);
        if (cfgErr) return fastify.httpErrors.badRequest(cfgErr);
      }

      const step = await fastify.db.ticketRouteStep.update({
        where: { id: request.params.stepId },
        data: {
          ...(name !== undefined && { name }),
          ...(stepType !== undefined && { stepType: stepType as PrismaRouteStepType }),
          ...(stepOrder !== undefined && { stepOrder }),
          ...(taskTypeOverride !== undefined && { taskTypeOverride: taskTypeOverride || null }),
          ...(promptKeyOverride !== undefined && { promptKeyOverride: promptKeyOverride || null }),
          ...(config !== undefined && { config: config ? (config as Prisma.InputJsonValue) : Prisma.JsonNull }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      // Re-generate route summary since steps changed
      generateRouteSummary(fastify, ai, request.params.id).catch((err) => {
        fastify.log.warn({ err, routeId: request.params.id }, 'Failed to regenerate route summary after step update');
      });

      const warnings: string[] = [];
      if (step.isActive && parentRoute) {
        const mismatchWarning = checkStepPhaseMismatch(effectiveStepType as RouteStepType, parentRoute.routeType as RouteType);
        if (mismatchWarning) warnings.push(mismatchWarning);
      }

      return { ...step, warnings };
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        const message =
          stepOrder !== undefined
            ? `Step order ${stepOrder} already exists in this route.`
            : 'A step with this order already exists in this route.';
        return fastify.httpErrors.conflict(message);
      }
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Route step not found');
      }
      throw err;
    }
  });

  // ─── Delete step ──────────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string; stepId: string } }>(
    '/api/ticket-routes/:id/steps/:stepId',
    async (request, reply) => {
      // Scope guard: verify the parent route is accessible before deleting its step
      const callerScope = await resolveClientScope(request);
      const scopeFilter = ticketRouteScopeFilter(callerScope);
      const parentRoute = await fastify.db.ticketRoute.findFirst({
        where: { id: request.params.id, ...scopeFilter },
        select: { id: true, clientId: true },
      });
      if (!parentRoute) return fastify.httpErrors.notFound('Ticket route not found');
      // Platform-scoped routes can only be mutated by admin/API-key callers
      if (parentRoute.clientId === null && callerScope.type !== 'all') {
        return fastify.httpErrors.forbidden('Platform-scoped routes can only be modified by global administrators');
      }

      try {
        const deleteResult = await fastify.db.ticketRouteStep.deleteMany({
          where: { id: request.params.stepId, routeId: request.params.id },
        });

        if (deleteResult.count === 0) {
          return fastify.httpErrors.notFound('Route step not found');
        }

        // Re-generate route summary since steps changed
        generateRouteSummary(fastify, ai, request.params.id).catch((err) => {
          fastify.log.warn({ err, routeId: request.params.id }, 'Failed to regenerate route summary after step delete');
        });

        reply.code(204);
      } catch (err) {
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Helper: generate AI summary for a route
// ---------------------------------------------------------------------------

async function generateRouteSummary(
  fastify: FastifyInstance,
  ai: AIRouter,
  routeId: string,
): Promise<string> {
  const route = await fastify.db.ticketRoute.findUnique({
    where: { id: routeId },
    include: { steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' } } },
  });
  if (!route) throw new Error(`Route ${routeId} not found`);

  const stepList = route.steps
    .map((s, i) => `${i + 1}. ${s.name} (${s.stepType})${s.taskTypeOverride ? ` [override: ${s.taskTypeOverride}]` : ''}`)
    .join('\n');

  const prompt = [
    `Route name: ${route.name}`,
    route.description ? `Description: ${route.description}` : '',
    route.category ? `Target category: ${route.category}` : 'Target category: Any (default route)',
    '',
    'Processing steps:',
    stepList || '(no steps defined)',
  ].filter(Boolean).join('\n');

  const res = await ai.generate({
    taskType: TaskType.SUMMARIZE_ROUTE,
    prompt,
    promptKey: 'routing.summarize-route.system',
  });

  const summary = res.content.trim();

  await fastify.db.ticketRoute.update({
    where: { id: routeId },
    data: { summary },
  });

  return summary;
}

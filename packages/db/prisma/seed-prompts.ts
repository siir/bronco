/**
 * Seed prompt keywords and sample overrides.
 *
 * Base prompts are hardcoded in packages/ai-provider/src/prompts/ —
 * this script only seeds the keyword registry and optional sample overrides.
 *
 * Can be run standalone: pnpm --filter @bronco/db exec tsx prisma/seed-prompts.ts
 * Also called from seed.ts as part of the main seed pipeline.
 */
import { PrismaClient } from '@prisma/client';

// ─── Keywords ───────────────────────────────────────────────────────────────

interface KeywordSeed {
  token: string;
  label: string;
  description: string;
  sampleValue: string | null;
  category: string;
}

const keywords: KeywordSeed[] = [
  // --- TICKET context ---
  {
    token: 'ticketId',
    label: 'Ticket ID',
    description: 'The unique identifier of the ticket being processed.',
    sampleValue: 'TKT-00042',
    category: 'TICKET',
  },
  {
    token: 'subject',
    label: 'Subject',
    description: 'The ticket or work item subject line.',
    sampleValue: 'Slow query on Orders table',
    category: 'TICKET',
  },
  {
    token: 'description',
    label: 'Description',
    description: 'The full description text of the ticket or work item.',
    sampleValue: 'The GetOrdersByCustomer stored proc is timing out during peak hours.',
    category: 'TICKET',
  },
  {
    token: 'category',
    label: 'Category',
    description: 'The ticket category (DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, etc.).',
    sampleValue: 'DATABASE_PERF',
    category: 'TICKET',
  },
  {
    token: 'priority',
    label: 'Priority',
    description: 'The ticket priority level (LOW, MEDIUM, HIGH, CRITICAL).',
    sampleValue: 'HIGH',
    category: 'TICKET',
  },
  {
    token: 'status',
    label: 'Status',
    description: 'The current ticket status (NEW, OPEN, IN_PROGRESS, WAITING, RESOLVED, CLOSED).',
    sampleValue: 'OPEN',
    category: 'TICKET',
  },
  {
    token: 'summary',
    label: 'Summary',
    description: 'AI-generated summary of the ticket (from Phase 1 summarization).',
    sampleValue: '- Customer reports stored procedure timeout\n- Occurs during peak hours (2-4pm)\n- Affects order lookup',
    category: 'TICKET',
  },
  {
    token: 'eventHistory',
    label: 'Event History',
    description: 'Chronological timeline of all ticket events formatted as "[type] actor (date): content".',
    sampleValue: '[EMAIL_INBOUND] user@example.com (2026-01-15): The query is timing out...',
    category: 'TICKET',
  },

  // --- EMAIL context ---
  {
    token: 'emailSubject',
    label: 'Email Subject',
    description: 'The subject line of the inbound email.',
    sampleValue: 'Re: Slow query on Orders table',
    category: 'EMAIL',
  },
  {
    token: 'emailBody',
    label: 'Email Body',
    description: 'The full text body of the inbound email.',
    sampleValue: 'Hi team, we are seeing timeouts on the GetOrdersByCustomer proc...',
    category: 'EMAIL',
  },
  {
    token: 'recipientName',
    label: 'Recipient Name',
    description: 'The name of the person the email is addressed to.',
    sampleValue: 'John Smith',
    category: 'EMAIL',
  },
  {
    token: 'senderSignature',
    label: 'Sender Signature',
    description: 'The name/signature to sign outbound emails with.',
    sampleValue: 'Bronco Support',
    category: 'EMAIL',
  },

  // --- DEVOPS context ---
  {
    token: 'clientName',
    label: 'Client Name',
    description: 'The name of the client organization associated with the work item.',
    sampleValue: 'Acme Corp',
    category: 'DEVOPS',
  },
  {
    token: 'workItemId',
    label: 'Work Item ID',
    description: 'The Azure DevOps work item ID.',
    sampleValue: '12345',
    category: 'DEVOPS',
  },
  {
    token: 'workflowState',
    label: 'Workflow State',
    description: 'Current state of the DevOps conversation workflow (idle, analyzing, questioning, planning, awaiting_approval, executing, completed).',
    sampleValue: 'analyzing',
    category: 'DEVOPS',
  },
  {
    token: 'conversationHistory',
    label: 'Conversation History',
    description: 'Full conversation history from ticket events, formatted as chronological exchanges.',
    sampleValue: '[AI_ANALYSIS] system: Based on the work item...\n[DEVOPS_INBOUND] user: The issue only happens on...',
    category: 'DEVOPS',
  },
  {
    token: 'planSteps',
    label: 'Plan Steps',
    description: 'The approved execution plan steps as a JSON array with step number, description, type, and details.',
    sampleValue: '[{"step":1,"description":"Check index usage","type":"analysis","details":"Run sp_BlitzIndex"}]',
    category: 'DEVOPS',
  },
  {
    token: 'userQuestion',
    label: 'User Question',
    description: 'A specific question from the user that needs to be answered about the proposed plan.',
    sampleValue: 'Will this require downtime?',
    category: 'DEVOPS',
  },

  // --- CODE context ---
  {
    token: 'issueTitle',
    label: 'Issue Title',
    description: 'The title of the issue being resolved by the code generator.',
    sampleValue: 'Fix null pointer in OrderService',
    category: 'CODE',
  },
  {
    token: 'issueDescription',
    label: 'Issue Description',
    description: 'The full description of the issue to be resolved.',
    sampleValue: 'OrderService.getById throws NullPointerException when order has no line items.',
    category: 'CODE',
  },
  {
    token: 'issueCategory',
    label: 'Issue Category',
    description: 'The category of the issue (BUG_FIX, FEATURE_REQUEST, etc.).',
    sampleValue: 'BUG_FIX',
    category: 'CODE',
  },
  {
    token: 'fileTree',
    label: 'File Tree',
    description: 'Full directory listing of the repository being analyzed.',
    sampleValue: 'src/\n  services/\n    OrderService.ts\n  models/\n    Order.ts',
    category: 'CODE',
  },
  {
    token: 'sourceContext',
    label: 'Source Context',
    description: 'Contents of relevant source files from the repository (truncated to ~3000 chars per file).',
    sampleValue: '--- src/services/OrderService.ts ---\nexport class OrderService { ... }',
    category: 'CODE',
  },
  {
    token: 'relevantCode',
    label: 'Relevant Code',
    description: 'Source code snippets from git grep that are relevant to the issue being analyzed.',
    sampleValue: 'src/api/orders.ts:42: const result = await db.query(sql);',
    category: 'CODE',
  },

  // --- DATABASE context ---
  {
    token: 'databaseHealth',
    label: 'Database Health',
    description: 'Database health metrics retrieved from MCP (CPU, memory, IO stats).',
    sampleValue: 'CPU: 85%, Active sessions: 42, Avg response time: 250ms',
    category: 'DATABASE',
  },
  {
    token: 'blockingTree',
    label: 'Blocking Tree',
    description: 'Active blocking chains in the database, showing head blockers and waiters.',
    sampleValue: 'Head blocker SPID 55 (UPDATE Orders) → blocked: SPID 62, SPID 71',
    category: 'DATABASE',
  },
  {
    token: 'waitStats',
    label: 'Wait Stats',
    description: 'Database wait statistics showing top wait types and durations.',
    sampleValue: 'PAGEIOLATCH_SH: 45%, LCK_M_S: 22%, CXPACKET: 15%',
    category: 'DATABASE',
  },

  // --- GENERAL context ---
  {
    token: 'analysisFindings',
    label: 'Analysis Findings',
    description: 'The results of the deep analysis phase, including root cause and recommendations.',
    sampleValue: 'Root cause: Missing index on Orders.CustomerId causes table scan during peak load.',
    category: 'GENERAL',
  },
  {
    token: 'extractedFacts',
    label: 'Extracted Facts',
    description: 'Structured data extracted from text (JSON with errorMessages, filesMentioned, servicesMentioned, etc.).',
    sampleValue: '{"errorMessages":["Timeout expired"],"servicesMentioned":["OrderService"],"databaseRelated":true}',
    category: 'GENERAL',
  },
];

// ─── Seed logic ─────────────────────────────────────────────────────────────

/**
 * Seed all prompt keywords into the database.
 * Accepts a PrismaClient instance so it can be called from seed.ts.
 */
export async function seedPromptKeywords(db: PrismaClient): Promise<void> {
  console.log('Seeding prompt keywords...');
  for (const kw of keywords) {
    await db.promptKeyword.upsert({
      where: { token: kw.token },
      update: {
        label: kw.label,
        description: kw.description,
        sampleValue: kw.sampleValue,
        category: kw.category,
      },
      create: kw,
    });
  }
  console.log(`  Seeded ${keywords.length} keywords.`);
}

// ─── Standalone entry point ─────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedPromptKeywords(prisma);
    console.log('Done. Base prompts are in packages/ai-provider/src/prompts/.');
    console.log('Use the control panel to add app-wide or per-client overrides.');
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (not when imported)
const isDirectRun = process.argv[1]?.endsWith('seed-prompts.ts') ?? false;
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

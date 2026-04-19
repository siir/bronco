import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedPromptKeywords } from './seed-prompts.js';

// Load .env from monorepo root (needed when running outside Docker, e.g. on Hugo via pnpm db:seed)
loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });

const prisma = new PrismaClient();

async function main() {
  // Create default admin person + operator (password: changeme — change
  // immediately in production). The Person holds the credential; the Operator
  // extension record grants control-panel access with ADMIN role.
  const adminEmail = 'admin@bronco.dev';
  const adminEmailLower = adminEmail.toLowerCase();
  const adminPasswordHash = await bcrypt.hash('changeme', 12);

  const adminPerson = await prisma.person.upsert({
    where: { emailLower: adminEmailLower },
    update: { passwordHash: adminPasswordHash },
    create: {
      email: adminEmail,
      emailLower: adminEmailLower,
      name: 'Admin',
      passwordHash: adminPasswordHash,
    },
  });
  console.log('Seeded admin person:', adminPerson.email);

  const defaultOperator = await prisma.operator.upsert({
    where: { personId: adminPerson.id },
    update: {},
    create: {
      personId: adminPerson.id,
      role: 'ADMIN',
      notifyEmail: true,
      notifySlack: false,
    },
  });
  console.log('Seeded default operator for person:', adminPerson.email, '(op id:', defaultOperator.id, ')');

  // Create a sample client for development
  const client = await prisma.client.upsert({
    where: { shortCode: 'demo' },
    update: {},
    create: {
      name: 'Demo Client',
      shortCode: 'demo',
      notes: 'Sample client for development',
    },
  });

  console.log('Seeded client:', client.name);

  // Create a sample person (contact — no portal access, no Operator extension)
  const demoEmail = 'demo@example.com';
  const person = await prisma.person.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Demo User',
      email: demoEmail,
      emailLower: demoEmail.toLowerCase(),
    },
  });

  // Mark the demo person as the primary contact for the demo client via a
  // ClientUser extension row (primary-contact lives on ClientUser now).
  await prisma.clientUser.upsert({
    where: { personId_clientId: { personId: person.id, clientId: client.id } },
    update: { isPrimary: true },
    create: {
      personId: person.id,
      clientId: client.id,
      userType: 'USER',
      isPrimary: true,
    },
  });

  console.log('Seeded person:', person.name);

  // Primary: Azure SQL Managed Instance (current production use case)
  const miSystem = await prisma.system.upsert({
    where: {
      clientId_name: {
        clientId: client.id,
        name: 'Demo Azure SQL MI',
      },
    },
    update: {},
    create: {
      clientId: client.id,
      name: 'Demo Azure SQL MI',
      dbEngine: 'AZURE_SQL_MI',
      host: 'demo-mi.abc123def456.database.windows.net',
      port: 3342,
      defaultDatabase: 'DemoDb',
      authMethod: 'SQL_AUTH',
      username: 'bronco_reader',
      useTls: true,
      trustServerCert: false,
      environment: 'DEVELOPMENT',
      notes: 'Demo Azure SQL MI instance (private endpoint, port 3342)',
    },
  });

  console.log('Seeded MI system:', miSystem.name);

  // Secondary: On-prem SQL Server (for future client testing)
  const onPremSystem = await prisma.system.upsert({
    where: {
      clientId_name: {
        clientId: client.id,
        name: 'Demo On-Prem SQL Server',
      },
    },
    update: {},
    create: {
      clientId: client.id,
      name: 'Demo On-Prem SQL Server',
      dbEngine: 'MSSQL',
      host: 'localhost',
      port: 1433,
      defaultDatabase: 'master',
      authMethod: 'SQL_AUTH',
      username: 'sa',
      environment: 'DEVELOPMENT',
      notes: 'Local dev SQL Server instance (on-prem pattern)',
    },
  });

  console.log('Seeded on-prem system:', onPremSystem.name);

  // Sample ticket with category
  const ticket = await prisma.ticket.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      clientId: client.id,
      systemId: miSystem.id,
      subject: 'Slow query on Orders table',
      description: 'The GetOrdersByCustomer stored proc is timing out during peak hours.',
      source: 'EMAIL',
      category: 'DATABASE_PERF',
      priority: 'HIGH',
      ticketNumber: 1,
      followers: {
        create: { personId: person.id, followerType: 'REQUESTER' },
      },
    },
  });

  console.log('Seeded ticket:', ticket.subject);

  // Seed default EMAIL ingestion route (global, any-source would match but
  // source=EMAIL is explicit for clarity). Uses upsert on a well-known ID
  // so re-running the seed is idempotent and doesn't duplicate.
  const emailRouteId = '00000000-0000-0000-0000-000000000010';
  const emailRouteSteps = [
    { stepOrder: 1, name: 'Resolve Thread', stepType: 'RESOLVE_THREAD', isActive: true },
    { stepOrder: 2, name: 'Summarize Email', stepType: 'SUMMARIZE_EMAIL', isActive: true },
    { stepOrder: 3, name: 'Categorize', stepType: 'CATEGORIZE', isActive: true },
    { stepOrder: 4, name: 'Triage Priority', stepType: 'TRIAGE_PRIORITY', isActive: true },
    { stepOrder: 5, name: 'Generate Title', stepType: 'GENERATE_TITLE', isActive: true },
    { stepOrder: 6, name: 'Create Ticket', stepType: 'CREATE_TICKET', isActive: true },
    { stepOrder: 7, name: 'Draft Receipt', stepType: 'DRAFT_RECEIPT', isActive: true },
  ];
  const emailRoute = await prisma.ticketRoute.upsert({
    where: { id: emailRouteId },
    update: {
      name: 'Default Email Ingestion',
      description: 'Resolves email threads, summarizes, categorizes, triages, generates title, creates ticket, and sends receipt.',
    },
    create: {
      id: emailRouteId,
      name: 'Default Email Ingestion',
      description: 'Resolves email threads, summarizes, categorizes, triages, generates title, creates ticket, and sends receipt.',
      routeType: 'INGESTION',
      source: 'EMAIL',
      isActive: true,
      isDefault: true,
      sortOrder: 100,
      steps: { createMany: { data: emailRouteSteps } },
    },
  });
  // Reconcile steps on existing routes — delete stale steps and upsert current ones
  await prisma.ticketRouteStep.deleteMany({ where: { routeId: emailRouteId } });
  await prisma.ticketRouteStep.createMany({ data: emailRouteSteps.map(s => ({ ...s, routeId: emailRouteId })) });
  console.log('Seeded email ingestion route:', emailRoute.name);

  // Seed default AZURE_DEVOPS ingestion route
  const devopsRouteId = '00000000-0000-0000-0000-000000000011';
  const devopsRouteSteps = [
    { stepOrder: 1, name: 'Categorize', stepType: 'CATEGORIZE', isActive: true },
    { stepOrder: 2, name: 'Triage Priority', stepType: 'TRIAGE_PRIORITY', isActive: true },
    { stepOrder: 3, name: 'Generate Title', stepType: 'GENERATE_TITLE', isActive: true },
    { stepOrder: 4, name: 'Create Ticket', stepType: 'CREATE_TICKET', isActive: true },
  ];
  const devopsRoute = await prisma.ticketRoute.upsert({
    where: { id: devopsRouteId },
    update: {
      name: 'Default DevOps Ingestion',
      description: 'Categorizes, triages, generates title, and creates ticket from Azure DevOps work items.',
    },
    create: {
      id: devopsRouteId,
      name: 'Default DevOps Ingestion',
      description: 'Categorizes, triages, generates title, and creates ticket from Azure DevOps work items.',
      routeType: 'INGESTION',
      source: 'AZURE_DEVOPS',
      isActive: true,
      isDefault: true,
      sortOrder: 101,
      steps: { createMany: { data: devopsRouteSteps } },
    },
  });
  await prisma.ticketRouteStep.deleteMany({ where: { routeId: devopsRouteId } });
  await prisma.ticketRouteStep.createMany({ data: devopsRouteSteps.map(s => ({ ...s, routeId: devopsRouteId })) });
  console.log('Seeded DevOps ingestion route:', devopsRoute.name);

  // Seed default MANUAL ingestion route (minimal — operator provides all fields)
  const manualRouteId = '00000000-0000-0000-0000-000000000012';
  const manualRouteSteps = [
    { stepOrder: 1, name: 'Create Ticket', stepType: 'CREATE_TICKET', isActive: true },
  ];
  const manualRoute = await prisma.ticketRoute.upsert({
    where: { id: manualRouteId },
    update: {
      name: 'Default Manual Ingestion',
      description: 'Creates ticket directly from operator-provided fields.',
    },
    create: {
      id: manualRouteId,
      name: 'Default Manual Ingestion',
      description: 'Creates ticket directly from operator-provided fields.',
      routeType: 'INGESTION',
      source: 'MANUAL',
      isActive: true,
      isDefault: true,
      sortOrder: 102,
      steps: { createMany: { data: manualRouteSteps } },
    },
  });
  await prisma.ticketRouteStep.deleteMany({ where: { routeId: manualRouteId } });
  await prisma.ticketRouteStep.createMany({ data: manualRouteSteps.map(s => ({ ...s, routeId: manualRouteId })) });
  console.log('Seeded Manual ingestion route:', manualRoute.name);

  // Seed default SLACK ingestion route
  const slackRouteId = '00000000-0000-0000-0000-000000000014';
  const slackRouteSteps = [
    { stepOrder: 1, name: 'Categorize', stepType: 'CATEGORIZE', isActive: true },
    { stepOrder: 2, name: 'Triage Priority', stepType: 'TRIAGE_PRIORITY', isActive: true },
    { stepOrder: 3, name: 'Generate Title', stepType: 'GENERATE_TITLE', isActive: true },
    { stepOrder: 4, name: 'Create Ticket', stepType: 'CREATE_TICKET', isActive: true },
  ];
  const slackRoute = await prisma.ticketRoute.upsert({
    where: { id: slackRouteId },
    update: {
      name: 'Default Slack Ingestion',
      description: 'Categorizes, triages, generates title, and creates ticket from Slack messages.',
    },
    create: {
      id: slackRouteId,
      name: 'Default Slack Ingestion',
      description: 'Categorizes, triages, generates title, and creates ticket from Slack messages.',
      routeType: 'INGESTION',
      source: 'SLACK',
      isActive: true,
      isDefault: true,
      sortOrder: 103,
      steps: { createMany: { data: slackRouteSteps } },
    },
  });
  await prisma.ticketRouteStep.deleteMany({ where: { routeId: slackRouteId } });
  await prisma.ticketRouteStep.createMany({ data: slackRouteSteps.map(s => ({ ...s, routeId: slackRouteId })) });
  console.log('Seeded Slack ingestion route:', slackRoute.name);

  // Seed default re-analysis route (used for incremental update after user reply)
  const reanalysisRouteId = '00000000-0000-0000-0000-000000000013';
  const reanalysisRouteSteps = [
    { stepOrder: 1, name: 'Update Analysis', stepType: 'UPDATE_ANALYSIS', isActive: true },
    { stepOrder: 2, name: 'Draft Findings Email', stepType: 'DRAFT_FINDINGS_EMAIL', isActive: true },
  ];
  const reanalysisRoute = await prisma.ticketRoute.upsert({
    where: { id: reanalysisRouteId },
    update: {
      name: 'Default Re-analysis (Update)',
      description: 'Incremental analysis triggered by a reply to an already-analyzed ticket. Compares new information against prior findings and sends updated results.',
    },
    create: {
      id: reanalysisRouteId,
      name: 'Default Re-analysis (Update)',
      description: 'Incremental analysis triggered by a reply to an already-analyzed ticket. Compares new information against prior findings and sends updated results.',
      routeType: 'ANALYSIS',
      isActive: true,
      isDefault: false,
      sortOrder: 200,
      steps: { createMany: { data: reanalysisRouteSteps } },
    },
  });
  await prisma.ticketRouteStep.deleteMany({ where: { routeId: reanalysisRouteId } });
  await prisma.ticketRouteStep.createMany({ data: reanalysisRouteSteps.map(s => ({ ...s, routeId: reanalysisRouteId })) });
  console.log('Seeded re-analysis route:', reanalysisRoute.name);

  // Seed default notification preferences (email enabled, Slack disabled)
  const notificationEvents = [
    'TICKET_CREATED',
    'ANALYSIS_COMPLETE',
    'SUFFICIENCY_CHANGED',
    'USER_REPLIED',
    'PLAN_READY',
    'PLAN_APPROVED',
    'PLAN_REJECTED',
    'RESOLUTION_COMPLETE',
    'SERVICE_HEALTH_ALERT',
    'PROBE_ALERT',
  ];
  for (const event of notificationEvents) {
    await prisma.notificationPreference.upsert({
      where: { event },
      update: {},
      create: {
        event,
        emailEnabled: true,
        slackEnabled: false,
        slackTarget: null,
        emailTarget: 'all_operators',
        isActive: true,
      },
    });
  }
  console.log('Seeded notification preferences:', notificationEvents.length, 'events');

  // Seed prompt keywords ({{token}} placeholders used in AI prompts)
  await seedPromptKeywords(prisma);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

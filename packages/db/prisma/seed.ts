import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedPromptKeywords } from './seed-prompts.js';

const prisma = new PrismaClient();

async function main() {
  // Create default admin user (password: changeme — change immediately in production)
  const adminPasswordHash = await bcrypt.hash('changeme', 12);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@bronco.dev' },
    update: {},
    create: {
      email: 'admin@bronco.dev',
      passwordHash: adminPasswordHash,
      name: 'Admin',
      role: 'ADMIN',
    },
  });
  console.log('Seeded admin user:', adminUser.email);

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

  // Create a sample contact
  const contact = await prisma.contact.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      clientId: client.id,
      name: 'Demo User',
      email: 'demo@example.com',
      role: 'Architect',
      isPrimary: true,
    },
  });

  console.log('Seeded contact:', contact.name);

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
      followers: {
        create: { contactId: contact.id, followerType: 'REQUESTER' },
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

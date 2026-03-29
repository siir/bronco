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

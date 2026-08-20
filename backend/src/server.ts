import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { scheduleBackgroundJobs } from './jobs/expiry.js';
import { startRealtime } from './realtime/index.js';

const app = buildApp();

async function start() {
  await prisma.$connect();
  startRealtime(app.server);
  scheduleBackgroundJobs();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

start().catch(async (error) => {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

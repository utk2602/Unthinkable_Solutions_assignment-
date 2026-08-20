import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = buildApp();

async function start() {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

start().catch(async (error) => {
  app.log.error(error);
  process.exit(1);
});

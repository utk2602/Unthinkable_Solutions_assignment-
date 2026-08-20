import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/routes.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: env.FRONTEND_ORIGIN, credentials: true });
  app.register(sensible);
  app.register(jwt, { secret: env.JWT_SECRET });
  app.register(swagger, {
    openapi: {
      info: { title: 'Ticket Booking API', version: '1.0.0' },
      servers: [{ url: '/api/v1' }]
    }
  });
  app.register(swaggerUi, { routePrefix: '/docs' });
  app.register(authRoutes, { prefix: '/api/v1/auth' });

  app.get('/health', async () => ({ status: 'ok', service: 'ticket-booking-api' }));
  app.setErrorHandler((error, _request, reply) => {
    const knownError = error instanceof Error ? error : new Error('Unknown server error');
    const statusCode = 'statusCode' in knownError && typeof knownError.statusCode === 'number' && knownError.statusCode < 500
      ? knownError.statusCode
      : 500;
    reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal Server Error' : knownError.name,
      message: knownError.message
    });
  });

  return app;
}

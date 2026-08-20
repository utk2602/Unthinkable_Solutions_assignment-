import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/routes.js';
import { organiserEventRoutes, publicEventRoutes } from './modules/events/routes.js';
import { seatRoutes } from './modules/holds/routes.js';
import { bookingRoutes } from './modules/bookings/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { venueRoutes } from './modules/venues/routes.js';

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
  app.register(venueRoutes, { prefix: '/api/v1/admin/venues' });
  app.register(organiserEventRoutes, { prefix: '/api/v1/organiser/events' });
  app.register(publicEventRoutes, { prefix: '/api/v1/events' });
  app.register(seatRoutes, { prefix: '/api/v1' });
  app.register(bookingRoutes, { prefix: '/api/v1' });
  app.register(reportRoutes, { prefix: '/api/v1/organiser/events' });

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

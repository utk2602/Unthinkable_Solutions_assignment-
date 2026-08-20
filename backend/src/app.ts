import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/routes.js';
import { organiserEventRoutes, organiserVenueRoutes, publicEventRoutes } from './modules/events/routes.js';
import { seatRoutes } from './modules/holds/routes.js';
import { bookingRoutes } from './modules/bookings/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { venueRoutes } from './modules/venues/routes.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: env.FRONTEND_ORIGIN, credentials: true });
  app.register(sensible);
  app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '7d' } });
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
  app.register(organiserVenueRoutes, { prefix: '/api/v1/organiser/venues' });
  app.register(publicEventRoutes, { prefix: '/api/v1/events' });
  app.register(seatRoutes, { prefix: '/api/v1' });
  app.register(bookingRoutes, { prefix: '/api/v1' });
  app.register(reportRoutes, { prefix: '/api/v1/organiser/events' });

  app.get('/health', async () => ({ status: 'ok', service: 'ticket-booking-api' }));
  app.setErrorHandler((error, request, reply) => {
    const knownError = error instanceof Error ? error : new Error('Unknown server error');
    if (knownError instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation Error', message: knownError.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') });
    }
    if (knownError instanceof Prisma.PrismaClientKnownRequestError) {
      if (knownError.code === 'P2002') return reply.status(409).send({ error: 'Conflict', message: 'A record with these values already exists.' });
      if (knownError.code === 'P2025') return reply.status(404).send({ error: 'Not Found', message: 'The requested record was not found.' });
      if (knownError.code === 'P2034') return reply.status(409).send({ error: 'Conflict', message: 'The request conflicted with another transaction. Please retry.' });
      if (knownError.code === 'P2010' && ['40001', '40P01'].includes(String(knownError.meta?.code))) {
        return reply.status(409).send({ error: 'Conflict', message: 'The inventory changed during this request. Please retry.' });
      }
    }
    const statusCode = 'statusCode' in knownError && typeof knownError.statusCode === 'number' && knownError.statusCode < 500
      ? knownError.statusCode
      : 500;
    if (statusCode === 500) request.log.error({ err: knownError }, 'Unhandled request error');
    reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal Server Error' : knownError.name,
      message: statusCode === 500 ? 'An unexpected server error occurred.' : knownError.message
    });
  });

  return app;
}

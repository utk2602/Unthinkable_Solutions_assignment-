import { Role } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';

const idSchema = z.string().uuid();
const venueSchema = z.object({ name: z.string().trim().min(2).max(120), address: z.string().trim().min(5).max(200), city: z.string().trim().min(2).max(80) });
const categorySchema = z.object({ name: z.string().trim().min(2).max(50), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#4F46E5'), sortOrder: z.coerce.number().int().min(0).default(0) });
const seatsSchema = z.object({
  seats: z.array(z.object({ rowLabel: z.string().trim().min(1).max(8), seatNumber: z.coerce.number().int().positive(), categoryId: z.string().uuid(), x: z.coerce.number().int().optional(), y: z.coerce.number().int().optional() })).min(1).max(500)
});

export const venueRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN));

  app.post('/', async (request, reply) => {
    const input = venueSchema.parse(request.body);
    const venue = await prisma.venue.create({ data: input });
    return reply.code(201).send({ venue });
  });

  app.get('/', async () => ({
    venues: await prisma.venue.findMany({
      include: { _count: { select: { seats: true, events: true } }, categories: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { name: 'asc' }
    })
  }));

  app.get('/:venueId', async (request, reply) => {
    const venueId = idSchema.parse((request.params as { venueId: string }).venueId);
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: { categories: { orderBy: { sortOrder: 'asc' } }, seats: { include: { category: true }, orderBy: [{ rowLabel: 'asc' }, { seatNumber: 'asc' }] } }
    });
    if (!venue) return reply.notFound('Venue not found.');
    return { venue };
  });

  app.post('/:venueId/categories', async (request, reply) => {
    const venueId = idSchema.parse((request.params as { venueId: string }).venueId);
    const input = categorySchema.parse(request.body);
    const venue = await prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) return reply.notFound('Venue not found.');
    const category = await prisma.seatCategory.create({ data: { venueId, ...input } });
    return reply.code(201).send({ category });
  });

  app.post('/:venueId/seats', async (request, reply) => {
    const venueId = idSchema.parse((request.params as { venueId: string }).venueId);
    const input = seatsSchema.parse(request.body);
    const categoryIds = [...new Set(input.seats.map((seat) => seat.categoryId))];
    const categories = await prisma.seatCategory.findMany({ where: { venueId, id: { in: categoryIds } } });
    if (categories.length !== categoryIds.length) return reply.badRequest('Every seat category must belong to this venue.');
    const positions = new Set(input.seats.map((seat) => `${seat.rowLabel}:${seat.seatNumber}`));
    if (positions.size !== input.seats.length) return reply.badRequest('Seat positions must be unique.');
    await prisma.venueSeat.createMany({ data: input.seats.map((seat) => ({ venueId, ...seat })) });
    return reply.code(201).send({ created: input.seats.length });
  });
};

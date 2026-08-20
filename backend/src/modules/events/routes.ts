import { EventStatus, EventType, Role } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';

const idSchema = z.string().uuid();
const eventBase = z.object({
  venueId: z.string().uuid(),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional(),
  type: z.nativeEnum(EventType),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  prices: z.array(z.object({ categoryId: z.string().uuid(), price: z.coerce.number().positive().max(1_000_000) })).min(1)
});
const eventInput = eventBase.refine((input) => input.endsAt > input.startsAt, { message: 'End time must be after start time.', path: ['endsAt'] });

async function ownedEvent(eventId: string, organiserId: string) {
  return prisma.event.findFirst({ where: { id: eventId, organiserId }, include: { categoryPrices: true, venue: { include: { seats: { where: { isActive: true } } } } } });
}

export const organiserEventRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ORGANISER));

  app.post('/', async (request, reply) => {
    const input = eventInput.parse(request.body);
    if (input.startsAt <= new Date()) return reply.badRequest('Event start time must be in the future.');
    const venue = await prisma.venue.findUnique({ where: { id: input.venueId }, include: { categories: true } });
    if (!venue) return reply.notFound('Venue not found.');
    const validCategoryIds = new Set(venue.categories.map((category) => category.id));
    const priceCategoryIds = new Set(input.prices.map((price) => price.categoryId));
    if (priceCategoryIds.size !== input.prices.length || [...priceCategoryIds].some((id) => !validCategoryIds.has(id))) {
      return reply.badRequest('Provide exactly one valid price for each selected venue category.');
    }
    const event = await prisma.event.create({
      data: {
        organiserId: request.user.id,
        venueId: input.venueId,
        title: input.title,
        description: input.description,
        type: input.type,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        categoryPrices: { create: input.prices }
      },
      include: { categoryPrices: { include: { category: true } }, venue: true }
    });
    return reply.code(201).send({ event });
  });

  app.get('/', async (request) => ({
    events: await prisma.event.findMany({ where: { organiserId: request.user.id }, include: { venue: true, categoryPrices: { include: { category: true } }, _count: { select: { bookings: true } } }, orderBy: { startsAt: 'asc' } })
  }));

  app.patch('/:eventId', async (request, reply) => {
    const eventId = idSchema.parse((request.params as { eventId: string }).eventId);
    const existing = await ownedEvent(eventId, request.user.id);
    if (!existing) return reply.notFound('Event not found.');
    if (existing.status !== EventStatus.DRAFT) return reply.badRequest('Only draft events may be changed.');
    const input = eventBase.partial().parse(request.body);
    const startsAt = input.startsAt ?? existing.startsAt;
    const endsAt = input.endsAt ?? existing.endsAt;
    if (startsAt <= new Date()) return reply.badRequest('Event start time must be in the future.');
    if (endsAt <= startsAt) return reply.badRequest('End time must be after start time.');
    const venueId = input.venueId ?? existing.venueId;
    const replacingPrices = Boolean(input.prices || input.venueId);
    const prices = input.prices ?? (input.venueId ? undefined : existing.categoryPrices.map((price) => ({ categoryId: price.categoryId, price: Number(price.price) })));
    if (replacingPrices && !prices) return reply.badRequest('Prices are required when changing the venue.');
    if (replacingPrices && prices) {
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, include: { categories: true } });
      if (!venue) return reply.notFound('Venue not found.');
      const validCategoryIds = new Set(venue.categories.map((category) => category.id));
      if (new Set(prices.map((price) => price.categoryId)).size !== prices.length || prices.some((price) => !validCategoryIds.has(price.categoryId))) {
        return reply.badRequest('Every price must reference a unique category from the selected venue.');
      }
    }
    const event = await prisma.event.update({
      where: { id: eventId },
      data: {
        venueId,
        title: input.title,
        description: input.description,
        type: input.type,
        startsAt,
        endsAt,
        ...(replacingPrices && prices ? { categoryPrices: { deleteMany: {}, create: prices } } : {})
      },
      include: { venue: true, categoryPrices: { include: { category: true } } }
    });
    return { event };
  });

  app.post('/:eventId/publish', async (request, reply) => {
    const eventId = idSchema.parse((request.params as { eventId: string }).eventId);
    const event = await ownedEvent(eventId, request.user.id);
    if (!event) return reply.notFound('Event not found.');
    if (event.status !== EventStatus.DRAFT) return reply.badRequest('Only draft events may be published.');
    if (event.startsAt <= new Date()) return reply.badRequest('Past events cannot be published.');
    if (event.venue.seats.length === 0) return reply.badRequest('The venue has no active seats.');
    const priceByCategory = new Map(event.categoryPrices.map((price) => [price.categoryId, price.price]));
    if (event.venue.seats.some((seat) => !priceByCategory.has(seat.categoryId))) return reply.badRequest('Every active venue category needs a price.');
    const published = await prisma.$transaction(async (tx) => {
      const claimed = await tx.event.updateMany({ where: { id: eventId, organiserId: request.user.id, status: EventStatus.DRAFT }, data: { status: EventStatus.PUBLISHED } });
      if (!claimed.count) throw app.httpErrors.conflict('Event was already published or changed.');
      await tx.showSeat.createMany({ data: event.venue.seats.map((seat) => ({ eventId, venueSeatId: seat.id, categoryId: seat.categoryId, rowLabel: seat.rowLabel, seatNumber: seat.seatNumber, price: priceByCategory.get(seat.categoryId)! })) });
      return tx.event.findUniqueOrThrow({ where: { id: eventId }, include: { venue: true, categoryPrices: { include: { category: true } } } });
    });
    return { event: published };
  });
};

export const organiserVenueRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ORGANISER));
  app.get('/', async () => ({
    venues: await prisma.venue.findMany({
      include: { categories: { orderBy: { sortOrder: 'asc' } }, _count: { select: { seats: true } } },
      orderBy: [{ city: 'asc' }, { name: 'asc' }]
    })
  }));
};

export const publicEventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request) => {
    const query = z.object({ q: z.string().trim().optional(), type: z.nativeEnum(EventType).optional(), city: z.string().trim().optional(), from: z.coerce.date().optional() }).parse(request.query);
    const events = await prisma.event.findMany({
      where: { status: EventStatus.PUBLISHED, startsAt: { gte: query.from ?? new Date() }, ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}), ...(query.type ? { type: query.type } : {}), ...(query.city ? { venue: { city: { equals: query.city, mode: 'insensitive' } } } : {}) },
      include: { venue: true, categoryPrices: { include: { category: true } }, _count: { select: { showSeats: true, bookings: true } } },
      orderBy: { startsAt: 'asc' }
    });
    return { events };
  });

  app.get('/:eventId', async (request, reply) => {
    const eventId = idSchema.parse((request.params as { eventId: string }).eventId);
    const event = await prisma.event.findFirst({ where: { id: eventId, status: EventStatus.PUBLISHED }, include: { venue: true, categoryPrices: { include: { category: true } }, organiser: { select: { name: true } } } });
    if (!event) return reply.notFound('Event not found.');
    return { event };
  });
};

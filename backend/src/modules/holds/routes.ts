import { EventStatus, HoldStatus, Prisma, Role, SeatStatus } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { lockShowSeats, releaseExpiredHolds } from './service.js';

const idSchema = z.string().uuid();
const holdInput = z.object({ seatIds: z.array(z.string().uuid()).min(1).max(8) });

function holdView(hold: { id: string; eventId: string; status: HoldStatus; expiresAt: Date; seats: Array<{ showSeat: unknown }> }) {
  return { id: hold.id, eventId: hold.eventId, status: hold.status, expiresAt: hold.expiresAt, seats: hold.seats.map((item) => item.showSeat) };
}

export const seatRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/:eventId/seats', async (request, reply) => {
    const eventId = idSchema.parse((request.params as { eventId: string }).eventId);
    await prisma.$transaction((tx) => releaseExpiredHolds(tx, eventId), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const event = await prisma.event.findFirst({
      where: { id: eventId, status: EventStatus.PUBLISHED },
      include: { showSeats: { include: { category: true }, orderBy: [{ rowLabel: 'asc' }, { seatNumber: 'asc' }] } }
    });
    if (!event) return reply.notFound('Event not found.');
    return { seats: event.showSeats };
  });

  app.post('/events/:eventId/holds', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const eventId = idSchema.parse((request.params as { eventId: string }).eventId);
    const { seatIds } = holdInput.parse(request.body);
    if (new Set(seatIds).size !== seatIds.length) return reply.badRequest('A seat can only be selected once.');
    const expiresAt = new Date(Date.now() + env.SEAT_HOLD_MINUTES * 60_000);

    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findFirst({ where: { id: eventId, status: EventStatus.PUBLISHED } });
      if (!event) throw app.httpErrors.notFound('Event not found.');
      await lockShowSeats(tx, seatIds);
      await releaseExpiredHolds(tx, eventId);
      const seats = await tx.showSeat.findMany({ where: { id: { in: seatIds }, eventId } });
      if (seats.length !== seatIds.length) throw app.httpErrors.badRequest('One or more selected seats do not belong to this event.');
      const unavailable = seats.filter((seat) => seat.status !== SeatStatus.AVAILABLE);
      if (unavailable.length) throw app.httpErrors.conflict('One or more selected seats are no longer available.');
      const hold = await tx.hold.create({
        data: { eventId, userId: request.user.id, expiresAt, seats: { create: seatIds.map((showSeatId) => ({ showSeatId })) } },
        include: { seats: { include: { showSeat: { include: { category: true } } } } }
      });
      await tx.showSeat.updateMany({ where: { id: { in: seatIds } }, data: { status: SeatStatus.HELD } });
      return hold;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return reply.code(201).send({ hold: holdView(result) });
  });

  app.get('/holds/:holdId', { preHandler: authenticate }, async (request, reply) => {
    const holdId = idSchema.parse((request.params as { holdId: string }).holdId);
    const hold = await prisma.hold.findFirst({ where: { id: holdId, userId: request.user.id }, include: { seats: { include: { showSeat: { include: { category: true } } } } } });
    if (!hold) return reply.notFound('Hold not found.');
    return { hold: holdView(hold) };
  });

  app.delete('/holds/:holdId', { preHandler: authenticate }, async (request, reply) => {
    const holdId = idSchema.parse((request.params as { holdId: string }).holdId);
    await prisma.$transaction(async (tx) => {
      const hold = await tx.hold.findFirst({ where: { id: holdId, userId: request.user.id, status: HoldStatus.ACTIVE }, include: { seats: true } });
      if (!hold) throw app.httpErrors.notFound('Active hold not found.');
      await lockShowSeats(tx, hold.seats.map((seat) => seat.showSeatId));
      await tx.showSeat.updateMany({ where: { id: { in: hold.seats.map((seat) => seat.showSeatId) }, status: SeatStatus.HELD }, data: { status: SeatStatus.AVAILABLE } });
      await tx.hold.update({ where: { id: hold.id }, data: { status: HoldStatus.RELEASED } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return reply.code(204).send();
  });
};

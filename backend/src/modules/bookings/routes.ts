import { BookingStatus, HoldStatus, NotificationType, OfferStatus, Prisma, Role, SeatStatus, WaitlistStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { lockShowSeats, releaseExpiredHolds } from '../holds/service.js';
import { offerNextWaitlistedCustomer } from '../waitlist/service.js';
import { emitSeatMapChanged } from '../../realtime/index.js';

const idSchema = z.string().uuid();
const waitlistInput = z.object({ categoryId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(8).default(1) });
const bookingInclude = { event: true, seats: { include: { showSeat: { include: { category: true } } }, orderBy: { showSeat: { seatNumber: 'asc' } } } } as const;

function reference() {
  return `TKT-${randomBytes(5).toString('hex').toUpperCase()}`;
}

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.post('/holds/:holdId/checkout', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const holdId = idSchema.parse((request.params as { holdId: string }).holdId);
    const idempotencyKey = request.headers['idempotency-key'];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 12 || idempotencyKey.length > 128)) {
      return reply.badRequest('Idempotency-Key must be between 12 and 128 characters.');
    }
    const booking = await prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const previous = await tx.booking.findUnique({ where: { idempotencyKey }, include: bookingInclude });
        if (previous) return previous;
      }
      const hold = await tx.hold.findFirst({ where: { id: holdId, userId: request.user.id }, include: { seats: true } });
      if (!hold || hold.status !== HoldStatus.ACTIVE) throw app.httpErrors.notFound('Active hold not found.');
      await lockShowSeats(tx, hold.seats.map((seat) => seat.showSeatId));
      if (hold.expiresAt <= new Date()) {
        await releaseExpiredHolds(tx, hold.eventId);
        throw app.httpErrors.gone('This seat hold has expired.');
      }
      const seats = await tx.showSeat.findMany({ where: { id: { in: hold.seats.map((seat) => seat.showSeatId) }, eventId: hold.eventId } });
      if (seats.length !== hold.seats.length || seats.some((seat) => seat.status !== SeatStatus.HELD)) throw app.httpErrors.conflict('Held seats are no longer available.');
      const bookingReference = reference();
      const qrPayload = JSON.stringify({ bookingReference, eventId: hold.eventId });
      const totalAmount = seats.reduce((sum, seat) => sum.plus(seat.price), new Prisma.Decimal(0));
      const created = await tx.booking.create({
        data: {
          eventId: hold.eventId,
          userId: request.user.id,
          reference: bookingReference,
          idempotencyKey: idempotencyKey ?? null,
          totalAmount,
          qrPayload,
          seats: { create: seats.map((seat) => ({ showSeatId: seat.id, pricePaid: seat.price })) },
          notifications: { create: { userId: request.user.id, type: NotificationType.BOOKING_CONFIRMATION, recipient: request.user.email, subject: `Your ticket ${bookingReference}`, body: qrPayload } }
        },
        include: bookingInclude
      });
      await tx.showSeat.updateMany({ where: { id: { in: seats.map((seat) => seat.id) } }, data: { status: SeatStatus.BOOKED } });
      await tx.hold.update({ where: { id: hold.id }, data: { status: HoldStatus.COMPLETED } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    emitSeatMapChanged(booking.eventId);
    return reply.code(201).send({ booking, qrCode: await QRCode.toDataURL(booking.qrPayload) });
  });

  app.get('/bookings', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request) => ({
    bookings: await prisma.booking.findMany({ where: { userId: request.user.id }, include: bookingInclude, orderBy: { createdAt: 'desc' } })
  }));

  app.get('/bookings/:bookingId', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const bookingId = idSchema.parse((request.params as { bookingId: string }).bookingId);
    const booking = await prisma.booking.findFirst({ where: { id: bookingId, userId: request.user.id }, include: bookingInclude });
    if (!booking) return reply.notFound('Booking not found.');
    return { booking, qrCode: await QRCode.toDataURL(booking.qrPayload) };
  });

  app.post('/bookings/:bookingId/cancel', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const bookingId = idSchema.parse((request.params as { bookingId: string }).bookingId);
    const cancellation = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({ where: { id: bookingId, userId: request.user.id, status: BookingStatus.CONFIRMED }, include: { seats: { include: { showSeat: true } } } });
      if (!booking) throw app.httpErrors.notFound('Confirmed booking not found.');
      await lockShowSeats(tx, booking.seats.map((seat) => seat.showSeatId));
      await tx.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() } });
      await tx.showSeat.updateMany({ where: { id: { in: booking.seats.map((seat) => seat.showSeatId) } }, data: { status: SeatStatus.AVAILABLE } });
      const generated = [];
      for (const seat of booking.seats) {
        const offer = await offerNextWaitlistedCustomer(tx, booking.eventId, seat.showSeat.categoryId, seat.showSeatId);
        if (offer) generated.push(offer);
      }
      for (const offer of generated) {
        await tx.notification.create({ data: { userId: offer.entry.userId, offerId: offer.id, type: NotificationType.WAITLIST_OFFER, recipient: offer.entry.user.email, subject: `A seat is available for ${offer.entry.eventId}`, body: `A seat is available. Complete your booking before ${offer.expiresAt.toISOString()}.` } });
      }
      await tx.notification.create({ data: { userId: request.user.id, bookingId: booking.id, type: NotificationType.BOOKING_CANCELLATION, recipient: request.user.email, subject: `Booking ${booking.reference} cancelled`, body: 'Your seats were released successfully.' } });
      return { eventId: booking.eventId, offers: generated };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    emitSeatMapChanged(cancellation.eventId);
    return { cancelled: true, waitlistOffersCreated: cancellation.offers.length };
  });

  app.post('/events/:eventId/waitlist', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const eventId = idSchema.parse((request.params as { eventId: string }).eventId);
    const input = waitlistInput.parse(request.body);
    const availableSeats = await prisma.showSeat.count({ where: { eventId, categoryId: input.categoryId, status: SeatStatus.AVAILABLE } });
    if (availableSeats > 0) return reply.badRequest('Seats in this category are still available; please book directly.');
    const categoryExists = await prisma.showSeat.count({ where: { eventId, categoryId: input.categoryId } });
    if (!categoryExists) return reply.badRequest('Seat category does not belong to this event.');
    const entry = await prisma.waitlistEntry.upsert({
      where: { eventId_userId_categoryId: { eventId, userId: request.user.id, categoryId: input.categoryId } },
      update: { quantity: input.quantity, status: WaitlistStatus.WAITING },
      create: { eventId, userId: request.user.id, categoryId: input.categoryId, quantity: input.quantity }
    });
    return reply.code(201).send({ waitlistEntry: entry });
  });

  app.get('/waitlist', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request) => ({
    entries: await prisma.waitlistEntry.findMany({ where: { userId: request.user.id }, include: { event: true, category: true, offers: { orderBy: { createdAt: 'desc' } } }, orderBy: { createdAt: 'desc' } })
  }));

  app.post('/waitlist/offers/:token/accept', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const token = z.string().min(20).parse((request.params as { token: string }).token);
    const booking = await prisma.$transaction(async (tx) => {
      const offer = await tx.waitlistOffer.findFirst({ where: { token, status: OfferStatus.ACTIVE, entry: { userId: request.user.id } }, include: { entry: true, seats: true } });
      if (!offer) throw app.httpErrors.notFound('Active waitlist offer not found.');
      await lockShowSeats(tx, offer.seats.map((seat) => seat.showSeatId));
      if (offer.expiresAt <= new Date()) {
        await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: OfferStatus.EXPIRED } });
        await tx.waitlistEntry.update({ where: { id: offer.entryId }, data: { status: WaitlistStatus.EXPIRED } });
        await tx.showSeat.updateMany({ where: { id: { in: offer.seats.map((seat) => seat.showSeatId) } }, data: { status: SeatStatus.AVAILABLE } });
        throw app.httpErrors.gone('This waitlist offer has expired.');
      }
      const seats = await tx.showSeat.findMany({ where: { id: { in: offer.seats.map((seat) => seat.showSeatId) } } });
      if (seats.some((seat) => seat.status !== SeatStatus.HELD)) throw app.httpErrors.conflict('The offered seat is no longer available.');
      const bookingReference = reference();
      const qrPayload = JSON.stringify({ bookingReference, eventId: offer.eventId });
      const totalAmount = seats.reduce((sum, seat) => sum.plus(seat.price), new Prisma.Decimal(0));
      const created = await tx.booking.create({
        data: { eventId: offer.eventId, userId: request.user.id, reference: bookingReference, totalAmount, qrPayload, seats: { create: seats.map((seat) => ({ showSeatId: seat.id, pricePaid: seat.price })) }, notifications: { create: { userId: request.user.id, type: NotificationType.BOOKING_CONFIRMATION, recipient: request.user.email, subject: `Your ticket ${bookingReference}`, body: qrPayload } } },
        include: bookingInclude
      });
      await tx.showSeat.updateMany({ where: { id: { in: seats.map((seat) => seat.id) } }, data: { status: SeatStatus.BOOKED } });
      await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: OfferStatus.ACCEPTED, acceptedAt: new Date() } });
      await tx.waitlistEntry.update({ where: { id: offer.entryId }, data: { status: WaitlistStatus.FULFILLED } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    emitSeatMapChanged(booking.eventId);
    return reply.code(201).send({ booking, qrCode: await QRCode.toDataURL(booking.qrPayload) });
  });
};

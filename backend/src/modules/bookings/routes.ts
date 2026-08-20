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
const waitlistInput = z.object({ categoryId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(1).default(1) });
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
    const checkout = await prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const previous = await tx.booking.findUnique({ where: { idempotencyKey }, include: bookingInclude });
        if (previous) {
          if (previous.userId !== request.user.id) throw app.httpErrors.conflict('This idempotency key is already in use.');
          return { kind: 'booked' as const, booking: previous };
        }
      }
      const hold = await tx.hold.findFirst({ where: { id: holdId, userId: request.user.id }, include: { event: { select: { startsAt: true } }, seats: true } });
      if (!hold || hold.status !== HoldStatus.ACTIVE) throw app.httpErrors.notFound('Active hold not found.');
      await lockShowSeats(tx, hold.seats.map((seat) => seat.showSeatId));
      const now = new Date();
      if (hold.expiresAt <= now || hold.event.startsAt <= now) {
        await tx.showSeat.updateMany({ where: { id: { in: hold.seats.map((seat) => seat.showSeatId) }, status: SeatStatus.HELD }, data: { status: SeatStatus.AVAILABLE } });
        const eventClosed = hold.event.startsAt <= now;
        await tx.hold.update({ where: { id: hold.id }, data: { status: eventClosed ? HoldStatus.RELEASED : HoldStatus.EXPIRED } });
        return { kind: eventClosed ? 'closed' as const : 'expired' as const, eventId: hold.eventId };
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
      return { kind: 'booked' as const, booking: created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (checkout.kind === 'booked' && checkout.booking) {
      emitSeatMapChanged(checkout.booking.eventId);
      return reply.code(201).send({ booking: checkout.booking, qrCode: await QRCode.toDataURL(checkout.booking.qrPayload) });
    }
    emitSeatMapChanged(checkout.eventId);
    return checkout.kind === 'expired'
      ? reply.gone('This seat hold has expired.')
      : reply.conflict('This event has already started.');
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
      const booking = await tx.booking.findFirst({ where: { id: bookingId, userId: request.user.id, status: BookingStatus.CONFIRMED }, include: { event: true, seats: { include: { showSeat: true } } } });
      if (!booking) throw app.httpErrors.notFound('Confirmed booking not found.');
      if (booking.event.startsAt <= new Date()) throw app.httpErrors.badRequest('Bookings cannot be cancelled after the event starts.');
      await lockShowSeats(tx, booking.seats.map((seat) => seat.showSeatId));
      await tx.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() } });
      await tx.showSeat.updateMany({ where: { id: { in: booking.seats.map((seat) => seat.showSeatId) } }, data: { status: SeatStatus.AVAILABLE } });
      const generated = [];
      for (const seat of booking.seats) {
        const offer = await offerNextWaitlistedCustomer(tx, booking.eventId, seat.showSeat.categoryId, seat.showSeatId);
        if (offer) generated.push(offer);
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
    const outcome = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findFirst({ where: { id: eventId, status: 'PUBLISHED', startsAt: { gt: new Date() } } });
      if (!event) throw app.httpErrors.notFound('Upcoming event not found.');
      const releasedSeatIds = await releaseExpiredHolds(tx, eventId);
      const categoryExists = await tx.showSeat.count({ where: { eventId, categoryId: input.categoryId } });
      if (!categoryExists) throw app.httpErrors.badRequest('Seat category does not belong to this event.');
      const availableSeats = await tx.showSeat.count({ where: { eventId, categoryId: input.categoryId, status: SeatStatus.AVAILABLE } });
      if (availableSeats > 0) return { kind: 'available' as const, releasedAny: releasedSeatIds.length > 0 };
      const existing = await tx.waitlistEntry.findUnique({ where: { eventId_userId_categoryId: { eventId, userId: request.user.id, categoryId: input.categoryId } } });
      if (existing?.status === WaitlistStatus.OFFERED) return { kind: 'offered' as const, releasedAny: releasedSeatIds.length > 0 };
      if (existing?.status === WaitlistStatus.WAITING) {
        const entry = await tx.waitlistEntry.update({ where: { id: existing.id }, data: { quantity: input.quantity } });
        return { kind: 'waiting' as const, entry, releasedAny: releasedSeatIds.length > 0 };
      }
      const entry = existing
        ? await tx.waitlistEntry.update({ where: { id: existing.id }, data: { quantity: input.quantity, status: WaitlistStatus.WAITING, createdAt: new Date() } })
        : await tx.waitlistEntry.create({ data: { eventId, userId: request.user.id, categoryId: input.categoryId, quantity: input.quantity } });
      return { kind: 'created' as const, entry, releasedAny: releasedSeatIds.length > 0 };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (outcome.releasedAny) emitSeatMapChanged(eventId);
    if (outcome.kind === 'available') return reply.badRequest('Seats in this category are still available; please book directly.');
    if (outcome.kind === 'offered') return reply.conflict('You already have an active offer for this category.');
    return reply.code(outcome.kind === 'created' ? 201 : 200).send({ waitlistEntry: outcome.entry });
  });

  app.get('/waitlist', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request) => ({
    entries: await prisma.waitlistEntry.findMany({ where: { userId: request.user.id }, include: { event: true, category: true, offers: { orderBy: { createdAt: 'desc' } } }, orderBy: { createdAt: 'desc' } })
  }));

  app.get('/waitlist/offers/:token', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const token = z.string().min(20).parse((request.params as { token: string }).token);
    const offer = await prisma.waitlistOffer.findFirst({
      where: { token, entry: { userId: request.user.id } },
      include: { event: { include: { venue: true } }, entry: { include: { category: true } }, seats: { include: { showSeat: true } } }
    });
    if (!offer) return reply.notFound('Waitlist offer not found.');
    return { offer };
  });

  app.delete('/waitlist/:entryId', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const entryId = idSchema.parse((request.params as { entryId: string }).entryId);
    const result = await prisma.$transaction(async (tx) => {
      const entry = await tx.waitlistEntry.findFirst({ where: { id: entryId, userId: request.user.id }, include: { offers: { where: { status: OfferStatus.ACTIVE }, include: { seats: { include: { showSeat: true } } } } } });
      if (!entry) throw app.httpErrors.notFound('Waitlist entry not found.');
      const activeOffer = entry.offers[0];
      if (!activeOffer) {
        if (entry.status !== WaitlistStatus.WAITING) throw app.httpErrors.badRequest('Only an active waitlist entry can be cancelled.');
        await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: WaitlistStatus.CANCELLED } });
        return { eventId: entry.eventId, changedSeats: false };
      }
      await lockShowSeats(tx, activeOffer.seats.map((seat) => seat.showSeatId));
      await tx.waitlistOffer.update({ where: { id: activeOffer.id }, data: { status: OfferStatus.CANCELLED } });
      await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: WaitlistStatus.CANCELLED } });
      await tx.showSeat.updateMany({ where: { id: { in: activeOffer.seats.map((seat) => seat.showSeatId) }, status: SeatStatus.HELD }, data: { status: SeatStatus.AVAILABLE } });
      for (const seat of activeOffer.seats) await offerNextWaitlistedCustomer(tx, entry.eventId, seat.showSeat.categoryId, seat.showSeatId);
      return { eventId: entry.eventId, changedSeats: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.changedSeats) emitSeatMapChanged(result.eventId);
    return reply.code(204).send();
  });

  app.post('/waitlist/offers/:token/accept', { preHandler: [authenticate, requireRole(Role.CUSTOMER)] }, async (request, reply) => {
    const token = z.string().min(20).parse((request.params as { token: string }).token);
    const acceptance = await prisma.$transaction(async (tx) => {
      const offer = await tx.waitlistOffer.findFirst({ where: { token, status: OfferStatus.ACTIVE, entry: { userId: request.user.id } }, include: { event: { select: { startsAt: true } }, entry: true, seats: true } });
      if (!offer) throw app.httpErrors.notFound('Active waitlist offer not found.');
      await lockShowSeats(tx, offer.seats.map((seat) => seat.showSeatId));
      const now = new Date();
      if (offer.expiresAt <= now || offer.event.startsAt <= now) {
        await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: OfferStatus.EXPIRED } });
        await tx.waitlistEntry.update({ where: { id: offer.entryId }, data: { status: WaitlistStatus.EXPIRED } });
        await tx.showSeat.updateMany({ where: { id: { in: offer.seats.map((seat) => seat.showSeatId) } }, data: { status: SeatStatus.AVAILABLE } });
        if (offer.event.startsAt > now) {
          const expiredSeats = await tx.showSeat.findMany({ where: { id: { in: offer.seats.map((seat) => seat.showSeatId) } } });
          for (const seat of expiredSeats) await offerNextWaitlistedCustomer(tx, offer.eventId, seat.categoryId, seat.id);
        }
        return { kind: 'expired' as const, eventId: offer.eventId };
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
      return { kind: 'booked' as const, booking: created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (acceptance.kind === 'expired') {
      emitSeatMapChanged(acceptance.eventId);
      return reply.gone('This waitlist offer has expired.');
    }
    const booking = acceptance.booking;
    emitSeatMapChanged(booking.eventId);
    return reply.code(201).send({ booking, qrCode: await QRCode.toDataURL(booking.qrPayload) });
  });
};

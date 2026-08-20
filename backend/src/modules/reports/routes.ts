import { BookingStatus, Role } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';

export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ORGANISER));
  app.get('/:eventId/report', async (request, reply) => {
    const eventId = z.string().uuid().parse((request.params as { eventId: string }).eventId);
    const event = await prisma.event.findFirst({ where: { id: eventId, organiserId: request.user.id }, include: { showSeats: true, bookings: { where: { status: BookingStatus.CONFIRMED }, include: { seats: { include: { showSeat: { include: { category: true } } } } } } } });
    if (!event) return reply.notFound('Event not found.');
    const confirmedBookings = event.bookings.length;
    const seatsSold = event.bookings.reduce((total, booking) => total + booking.seats.length, 0);
    const revenue = event.bookings.reduce((total, booking) => total + Number(booking.totalAmount), 0);
    const revenueByCategory = event.bookings.flatMap((booking) => booking.seats).reduce<Record<string, { seatsSold: number; revenue: number }>>((summary, seat) => {
      const category = seat.showSeat.category.name;
      summary[category] ??= { seatsSold: 0, revenue: 0 };
      summary[category].seatsSold += 1;
      summary[category].revenue += Number(seat.pricePaid);
      return summary;
    }, {});
    return { report: { eventId, confirmedBookings, seatsSold, totalSeats: event.showSeats.length, occupancyPercent: event.showSeats.length ? Number(((seatsSold / event.showSeats.length) * 100).toFixed(2)) : 0, revenue, revenueByCategory } };
  });
};

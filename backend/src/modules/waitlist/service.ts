import { NotificationType, OfferStatus, Prisma, SeatStatus, WaitlistStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

export async function offerNextWaitlistedCustomer(tx: Prisma.TransactionClient, eventId: string, categoryId: string, showSeatId: string) {
  const entry = await tx.waitlistEntry.findFirst({
    where: { eventId, categoryId, status: WaitlistStatus.WAITING, event: { status: 'PUBLISHED', startsAt: { gt: new Date() } } },
    orderBy: { createdAt: 'asc' }
  });
  if (!entry) return null;
  const claim = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: WaitlistStatus.WAITING }, data: { status: WaitlistStatus.OFFERED } });
  if (!claim.count) return null;
  const expiresAt = new Date(Date.now() + env.WAITLIST_OFFER_MINUTES * 60_000);
  const offer = await tx.waitlistOffer.create({
    data: {
      entryId: entry.id,
      eventId,
      token: randomBytes(24).toString('base64url'),
      expiresAt,
      seats: { create: { showSeatId } }
    },
    include: { entry: { include: { user: true } }, event: { select: { title: true } }, seats: { include: { showSeat: true } } }
  });
  await tx.showSeat.update({ where: { id: showSeatId }, data: { status: SeatStatus.HELD } });
  await tx.notification.create({
    data: {
      userId: offer.entry.userId,
      offerId: offer.id,
      type: NotificationType.WAITLIST_OFFER,
      recipient: offer.entry.user.email,
      subject: `A seat is available for ${offer.event.title}`,
      body: `A seat is available. Complete your booking before ${offer.expiresAt.toISOString()}.`
    }
  });
  return offer;
}

export async function expireWaitlistOffers(tx: Prisma.TransactionClient) {
  const offers = await tx.waitlistOffer.findMany({
    where: { status: OfferStatus.ACTIVE, expiresAt: { lte: new Date() } },
    include: { seats: true }
  });
  for (const offer of offers) {
    await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: OfferStatus.EXPIRED } });
    await tx.waitlistEntry.update({ where: { id: offer.entryId }, data: { status: WaitlistStatus.EXPIRED } });
    await tx.showSeat.updateMany({ where: { id: { in: offer.seats.map((seat) => seat.showSeatId) }, status: SeatStatus.HELD }, data: { status: SeatStatus.AVAILABLE } });
  }
  return offers;
}

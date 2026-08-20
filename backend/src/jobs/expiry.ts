import { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { releaseExpiredHolds } from '../modules/holds/service.js';
import { expireWaitlistOffers, offerNextWaitlistedCustomer } from '../modules/waitlist/service.js';
import { deliverPendingNotifications } from '../modules/notifications/service.js';
import { emitSeatMapChanged } from '../realtime/index.js';

export async function runBackgroundJobs() {
  const impactedEventIds = await prisma.$transaction(async (tx) => {
    const expiredOfferRows = await tx.waitlistOffer.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, include: { seats: { include: { showSeat: true } } } });
    await releaseExpiredHolds(tx);
    await expireWaitlistOffers(tx);
    for (const offer of expiredOfferRows) {
      for (const seat of offer.seats) {
        const nextOffer = await offerNextWaitlistedCustomer(tx, offer.eventId, seat.showSeat.categoryId, seat.showSeatId);
        if (nextOffer) {
          await tx.notification.create({ data: { userId: nextOffer.entry.userId, offerId: nextOffer.id, type: NotificationType.WAITLIST_OFFER, recipient: nextOffer.entry.user.email, subject: 'A waitlist seat is available', body: `A seat is available. Complete your booking before ${nextOffer.expiresAt.toISOString()}.` } });
        }
      }
    }
    return [...new Set(expiredOfferRows.map((offer) => offer.eventId))];
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  impactedEventIds.forEach(emitSeatMapChanged);
  await deliverPendingNotifications();
}

export function scheduleBackgroundJobs() {
  void runBackgroundJobs();
  const interval = setInterval(() => void runBackgroundJobs(), 30_000);
  interval.unref();
}

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { releaseExpiredHolds } from '../modules/holds/service.js';
import { expireWaitlistOffers, offerNextWaitlistedCustomer } from '../modules/waitlist/service.js';
import { deliverPendingNotifications } from '../modules/notifications/service.js';
import { emitSeatMapChanged } from '../realtime/index.js';
import { lockShowSeats } from '../modules/holds/service.js';

export async function runInventoryExpiry() {
  const impactedEventIds = await prisma.$transaction(async (tx) => {
    const expiredHoldRows = await tx.hold.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, select: { eventId: true } });
    const expiredOfferRows = await tx.waitlistOffer.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, include: { seats: { include: { showSeat: true } } } });
    await lockShowSeats(tx, expiredOfferRows.flatMap((offer) => offer.seats.map((seat) => seat.showSeatId)));
    await releaseExpiredHolds(tx);
    await expireWaitlistOffers(tx);
    for (const offer of expiredOfferRows) {
      for (const seat of offer.seats) {
        await offerNextWaitlistedCustomer(tx, offer.eventId, seat.showSeat.categoryId, seat.showSeatId);
      }
    }
    return [...new Set([...expiredHoldRows.map((hold) => hold.eventId), ...expiredOfferRows.map((offer) => offer.eventId)])];
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
  impactedEventIds.forEach(emitSeatMapChanged);
}

export async function runBackgroundJobs() {
  await runInventoryExpiry();
  await deliverPendingNotifications();
}

export function scheduleBackgroundJobs() {
  let running = false;
  const safeRun = async () => {
    if (running) return;
    running = true;
    try {
      await runBackgroundJobs();
    } catch (error) {
      console.error('Background job failed:', error);
    } finally {
      running = false;
    }
  };
  void safeRun();
  const interval = setInterval(() => void safeRun(), 30_000);
  interval.unref();
}

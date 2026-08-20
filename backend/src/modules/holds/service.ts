import { HoldStatus, Prisma, SeatStatus } from '@prisma/client';

type DbClient = Prisma.TransactionClient;

export async function lockShowSeats(tx: DbClient, seatIds: string[]) {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM "ShowSeat"
    WHERE id IN (${Prisma.join([...seatIds].sort())})
    ORDER BY id
    FOR UPDATE
  `);
}

export async function releaseExpiredHolds(tx: DbClient, eventId?: string) {
  const expiredHolds = await tx.hold.findMany({
    where: { status: HoldStatus.ACTIVE, expiresAt: { lte: new Date() }, ...(eventId ? { eventId } : {}) },
    include: { seats: { select: { showSeatId: true } } }
  });
  if (!expiredHolds.length) return [] as string[];

  const holdIds = expiredHolds.map((hold) => hold.id);
  const seatIds = [...new Set(expiredHolds.flatMap((hold) => hold.seats.map((seat) => seat.showSeatId)))];
  await tx.showSeat.updateMany({ where: { id: { in: seatIds }, status: SeatStatus.HELD }, data: { status: SeatStatus.AVAILABLE } });
  await tx.hold.updateMany({ where: { id: { in: holdIds }, status: HoldStatus.ACTIVE }, data: { status: HoldStatus.EXPIRED } });
  return seatIds;
}

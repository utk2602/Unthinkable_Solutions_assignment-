import { SeatStatus } from '@prisma/client';

export function unavailableSeatIds(seats: Array<{ id: string; status: SeatStatus }>) {
  return seats.filter((seat) => seat.status !== SeatStatus.AVAILABLE).map((seat) => seat.id);
}

export function holdIsExpired(expiresAt: Date, now = new Date()) {
  return expiresAt.getTime() <= now.getTime();
}

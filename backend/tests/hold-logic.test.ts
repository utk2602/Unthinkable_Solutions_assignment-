import { SeatStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { holdIsExpired, unavailableSeatIds } from '../src/modules/holds/logic.js';

describe('seat hold rules', () => {
  it('only flags held or booked seats as unavailable', () => {
    expect(unavailableSeatIds([
      { id: 'available', status: SeatStatus.AVAILABLE },
      { id: 'held', status: SeatStatus.HELD },
      { id: 'booked', status: SeatStatus.BOOKED }
    ])).toEqual(['held', 'booked']);
  });

  it('expires a hold exactly at its expiry timestamp', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(holdIsExpired(new Date('2026-08-20T12:00:00.000Z'), now)).toBe(true);
    expect(holdIsExpired(new Date('2026-08-20T12:00:01.000Z'), now)).toBe(false);
  });
});

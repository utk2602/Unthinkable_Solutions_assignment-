import { PrismaClient, Role, EventStatus, EventType, SeatStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('DemoPass123!', 12);
  const [admin, organiser, customer] = await Promise.all([
    prisma.user.upsert({ where: { email: 'admin@ticketly.test' }, update: {}, create: { name: 'Admin User', email: 'admin@ticketly.test', passwordHash, role: Role.ADMIN } }),
    prisma.user.upsert({ where: { email: 'organiser@ticketly.test' }, update: {}, create: { name: 'Event Organiser', email: 'organiser@ticketly.test', passwordHash, role: Role.ORGANISER } }),
    prisma.user.upsert({ where: { email: 'customer@ticketly.test' }, update: {}, create: { name: 'Demo Customer', email: 'customer@ticketly.test', passwordHash, role: Role.CUSTOMER } })
  ]);

  void admin;
  void customer;
  const venue = await prisma.venue.upsert({
    where: { id: '11111111-1111-4111-8111-111111111111' },
    update: {},
    create: { id: '11111111-1111-4111-8111-111111111111', name: 'Aurora Arena', address: '42 Market Street', city: 'Bengaluru' }
  });
  const premium = await prisma.seatCategory.upsert({
    where: { venueId_name: { venueId: venue.id, name: 'Premium' } },
    update: {},
    create: { venueId: venue.id, name: 'Premium', color: '#F59E0B', sortOrder: 1 }
  });
  const standard = await prisma.seatCategory.upsert({
    where: { venueId_name: { venueId: venue.id, name: 'Standard' } },
    update: {},
    create: { venueId: venue.id, name: 'Standard', color: '#4F46E5', sortOrder: 2 }
  });

  for (const rowLabel of ['A', 'B', 'C', 'D']) {
    for (let seatNumber = 1; seatNumber <= 8; seatNumber += 1) {
      const categoryId = ['A', 'B'].includes(rowLabel) ? premium.id : standard.id;
      await prisma.venueSeat.upsert({
        where: { venueId_rowLabel_seatNumber: { venueId: venue.id, rowLabel, seatNumber } },
        update: {},
        create: { venueId: venue.id, categoryId, rowLabel, seatNumber }
      });
    }
  }

  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  const event = await prisma.event.upsert({
    where: { id: '22222222-2222-4222-8222-222222222222' },
    update: {},
    create: { id: '22222222-2222-4222-8222-222222222222', organiserId: organiser.id, venueId: venue.id, title: 'Starlight: Live in Concert', description: 'A demo concert for the booking system.', type: EventType.CONCERT, startsAt, endsAt, status: EventStatus.PUBLISHED }
  });
  await prisma.eventCategoryPrice.upsert({ where: { eventId_categoryId: { eventId: event.id, categoryId: premium.id } }, update: {}, create: { eventId: event.id, categoryId: premium.id, price: 1500 } });
  await prisma.eventCategoryPrice.upsert({ where: { eventId_categoryId: { eventId: event.id, categoryId: standard.id } }, update: {}, create: { eventId: event.id, categoryId: standard.id, price: 800 } });

  const venueSeats = await prisma.venueSeat.findMany({ where: { venueId: venue.id, isActive: true } });
  for (const seat of venueSeats) {
    const price = seat.categoryId === premium.id ? 1500 : 800;
    await prisma.showSeat.upsert({
      where: { eventId_venueSeatId: { eventId: event.id, venueSeatId: seat.id } },
      update: {},
      create: { eventId: event.id, venueSeatId: seat.id, categoryId: seat.categoryId, rowLabel: seat.rowLabel, seatNumber: seat.seatNumber, price, status: SeatStatus.AVAILABLE }
    });
  }
}

main().then(() => prisma.$disconnect()).catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

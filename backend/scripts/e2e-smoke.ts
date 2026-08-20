import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma.js';
import { runInventoryExpiry } from '../src/jobs/expiry.js';

const baseUrl = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const marker = Date.now();
const password = 'SmokePass123!';
const customerIds: string[] = [];
let venueId = '';
let eventId = '';

type Result = { status: number; data: any };

async function request(path: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function login(email: string, loginPassword: string) {
  const result = await request('/auth/login', { method: 'POST', body: { email, password: loginPassword } });
  assert.equal(result.status, 200, `Login failed for ${email}: ${JSON.stringify(result.data)}`);
  return result.data.token as string;
}

async function register(label: string) {
  const result = await request('/auth/register', { method: 'POST', body: { name: `Smoke ${label}`, email: `smoke-${label}-${marker}@ticketly.test`, password, role: 'CUSTOMER' } });
  assert.equal(result.status, 201, `Registration failed: ${JSON.stringify(result.data)}`);
  customerIds.push(result.data.user.id);
  return result.data.token as string;
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    if (customerIds.length) await tx.notification.deleteMany({ where: { userId: { in: customerIds } } });
    if (eventId) {
      await tx.waitlistOffer.deleteMany({ where: { eventId } });
      await tx.waitlistEntry.deleteMany({ where: { eventId } });
      await tx.booking.deleteMany({ where: { eventId } });
      await tx.hold.deleteMany({ where: { eventId } });
      await tx.event.deleteMany({ where: { id: eventId } });
    }
    if (venueId) await tx.venue.deleteMany({ where: { id: venueId } });
    if (customerIds.length) await tx.user.deleteMany({ where: { id: { in: customerIds } } });
  });
}

async function cleanupStaleFixtures() {
  const [users, venues, events] = await Promise.all([
    prisma.user.findMany({ where: { email: { startsWith: 'smoke-' } }, select: { id: true } }),
    prisma.venue.findMany({ where: { name: { startsWith: 'Smoke Venue ' } }, select: { id: true } }),
    prisma.event.findMany({ where: { title: { startsWith: 'Smoke Event ' } }, select: { id: true } })
  ]);
  const userIds = users.map((item) => item.id);
  const venueIds = venues.map((item) => item.id);
  const eventIds = events.map((item) => item.id);
  await prisma.$transaction(async (tx) => {
    if (userIds.length) await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
    if (eventIds.length) {
      await tx.waitlistOffer.deleteMany({ where: { eventId: { in: eventIds } } });
      await tx.waitlistEntry.deleteMany({ where: { eventId: { in: eventIds } } });
      await tx.booking.deleteMany({ where: { eventId: { in: eventIds } } });
      await tx.hold.deleteMany({ where: { eventId: { in: eventIds } } });
      await tx.event.deleteMany({ where: { id: { in: eventIds } } });
    }
    if (venueIds.length) await tx.venue.deleteMany({ where: { id: { in: venueIds } } });
    if (userIds.length) await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

await cleanupStaleFixtures();
try {
  const [adminToken, organiserToken, buyerToken, firstWaiterToken, secondWaiterToken] = await Promise.all([
    login('admin@ticketly.test', 'DemoPass123!'),
    login('organiser@ticketly.test', 'DemoPass123!'),
    register('buyer'),
    register('first'),
    register('second')
  ]);

  const forbidden = await request('/admin/venues', { token: buyerToken });
  assert.equal(forbidden.status, 403, 'Customer unexpectedly accessed an admin route.');
  const malformed = await request('/admin/venues', { method: 'POST', token: adminToken, body: { name: 'x' } });
  assert.equal(malformed.status, 400, 'Malformed venue payload was not rejected.');

  const venue = await request('/admin/venues', { method: 'POST', token: adminToken, body: { name: `Smoke Venue ${marker}`, address: '1 Test Avenue', city: 'Test City' } });
  assert.equal(venue.status, 201, JSON.stringify(venue.data));
  venueId = venue.data.venue.id;
  const category = await request(`/admin/venues/${venueId}/categories`, { method: 'POST', token: adminToken, body: { name: 'Standard', color: '#4F46E5' } });
  assert.equal(category.status, 201, JSON.stringify(category.data));
  const categoryId = category.data.category.id as string;
  const layout = await request(`/admin/venues/${venueId}/seats`, { method: 'POST', token: adminToken, body: { seats: [{ rowLabel: 'A', seatNumber: 1, categoryId }] } });
  assert.equal(layout.status, 201, JSON.stringify(layout.data));

  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const draft = await request('/organiser/events', { method: 'POST', token: organiserToken, body: { venueId, title: `Smoke Event ${marker}`, description: 'Automated end-to-end fixture', type: 'CONCERT', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 2 * 60 * 60_000).toISOString(), prices: [{ categoryId, price: 499 }] } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  eventId = draft.data.event.id;
  const published = await request(`/organiser/events/${eventId}/publish`, { method: 'POST', token: organiserToken, body: {} });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const seatMap = await request(`/events/${eventId}/seats`);
  assert.equal(seatMap.status, 200);
  assert.equal(seatMap.data.seats.length, 1);
  const seatId = seatMap.data.seats[0].id as string;

  const simultaneous = await Promise.all([
    request(`/events/${eventId}/holds`, { method: 'POST', token: buyerToken, body: { seatIds: [seatId] } }),
    request(`/events/${eventId}/holds`, { method: 'POST', token: firstWaiterToken, body: { seatIds: [seatId] } })
  ]);
  assert.deepEqual(simultaneous.map((result) => result.status).sort(), [201, 409], 'Concurrent holds did not produce exactly one winner.');
  const winningHold = simultaneous.find((result) => result.status === 201)!.data.hold.id;
  const winningToken = simultaneous[0].status === 201 ? buyerToken : firstWaiterToken;
  assert.equal((await request(`/holds/${winningHold}`, { method: 'DELETE', token: winningToken })).status, 204);

  const expiring = await request(`/events/${eventId}/holds`, { method: 'POST', token: buyerToken, body: { seatIds: [seatId] } });
  assert.equal(expiring.status, 201);
  await prisma.hold.update({ where: { id: expiring.data.hold.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  const afterExpiry = await request(`/events/${eventId}/seats`);
  assert.equal(afterExpiry.data.seats[0].status, 'AVAILABLE', 'Expired hold did not release its seat.');
  assert.equal((await prisma.hold.findUniqueOrThrow({ where: { id: expiring.data.hold.id } })).status, 'EXPIRED');

  const checkoutHold = await request(`/events/${eventId}/holds`, { method: 'POST', token: buyerToken, body: { seatIds: [seatId] } });
  assert.equal(checkoutHold.status, 201);
  const idempotencyKey = `smoke-${marker}-checkout`;
  const checkout = await request(`/holds/${checkoutHold.data.hold.id}/checkout`, { method: 'POST', token: buyerToken, headers: { 'Idempotency-Key': idempotencyKey }, body: {} });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.data));
  assert.match(checkout.data.qrCode, /^data:image\/png;base64,/);
  const retry = await request(`/holds/${checkoutHold.data.hold.id}/checkout`, { method: 'POST', token: buyerToken, headers: { 'Idempotency-Key': idempotencyKey }, body: {} });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.booking.id, checkout.data.booking.id, 'Idempotent retry created a different booking.');

  assert.equal((await request(`/events/${eventId}/waitlist`, { method: 'POST', token: firstWaiterToken, body: { categoryId, quantity: 1 } })).status, 201);
  assert.equal((await request(`/events/${eventId}/waitlist`, { method: 'POST', token: firstWaiterToken, body: { categoryId, quantity: 1 } })).status, 200);
  assert.equal((await request(`/events/${eventId}/waitlist`, { method: 'POST', token: secondWaiterToken, body: { categoryId, quantity: 1 } })).status, 201);
  const cancellation = await request(`/bookings/${checkout.data.booking.id}/cancel`, { method: 'POST', token: buyerToken, body: {} });
  assert.equal(cancellation.status, 200);
  assert.equal(cancellation.data.waitlistOffersCreated, 1);

  const firstEntries = await request('/waitlist', { token: firstWaiterToken });
  const firstOffer = firstEntries.data.entries[0].offers.find((offer: any) => offer.status === 'ACTIVE');
  assert.ok(firstOffer, 'First FIFO customer did not receive an offer.');
  assert.equal((await request(`/waitlist/offers/${firstOffer.token}`, { token: firstWaiterToken })).status, 200);
  await prisma.waitlistOffer.update({ where: { id: firstOffer.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await runInventoryExpiry();
  const firstAfterExpiry = await request('/waitlist', { token: firstWaiterToken });
  assert.equal(firstAfterExpiry.data.entries[0].status, 'EXPIRED');
  const secondEntries = await request('/waitlist', { token: secondWaiterToken });
  const secondOffer = secondEntries.data.entries[0].offers.find((offer: any) => offer.status === 'ACTIVE');
  assert.ok(secondOffer, 'Expired offer was not advanced to the next FIFO customer.');
  const accepted = await request(`/waitlist/offers/${secondOffer.token}/accept`, { method: 'POST', token: secondWaiterToken, body: {} });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.match(accepted.data.qrCode, /^data:image\/png;base64,/);

  const report = await request(`/organiser/events/${eventId}/report`, { token: organiserToken });
  assert.equal(report.status, 200);
  assert.equal(report.data.report.confirmedBookings, 1);
  assert.equal(report.data.report.seatsSold, 1);
  assert.equal(report.data.report.revenue, 499);
  console.log('E2E smoke passed: RBAC, validation, venue/event setup, concurrency, TTL, checkout, QR, cancellation, FIFO waitlist, offer expiry, acceptance, and reporting.');
} finally {
  await cleanup();
  await prisma.$disconnect();
}

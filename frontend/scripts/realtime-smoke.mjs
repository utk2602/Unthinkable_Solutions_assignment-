import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const socketUrl = apiUrl.replace(/\/api\/v1$/, '');
let token = '';
let holdId = '';

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'customer@ticketly.test', password: 'DemoPass123!' }) });
assert.equal(login.status, 200, JSON.stringify(login.data));
token = login.data.token;
const events = (await request('/events')).data.events ?? [];
let selected;
for (const event of events) {
  const map = await request(`/events/${event.id}/seats`);
  const seat = map.data.seats?.find((item) => item.status === 'AVAILABLE');
  if (seat) { selected = { event, seat }; break; }
}
assert.ok(selected, 'No available seeded event seat was found for the realtime smoke test.');

const socket = io(socketUrl, { transports: ['websocket'] });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out.')), 5_000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', reject);
  });
  socket.emit('event:join', selected.event.id);
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('seat-map:changed was not received.')), 5_000);
    socket.once('seat-map:changed', (payload) => { clearTimeout(timeout); resolve(payload); });
  });
  const hold = await request(`/events/${selected.event.id}/holds`, { method: 'POST', body: JSON.stringify({ seatIds: [selected.seat.id] }) });
  assert.equal(hold.status, 201, JSON.stringify(hold.data));
  holdId = hold.data.hold.id;
  const payload = await changed;
  assert.equal(payload.eventId, selected.event.id);
  console.log('Realtime smoke passed: a seat hold emitted seat-map:changed to the event room.');
} finally {
  if (holdId) await request(`/holds/${holdId}`, { method: 'DELETE' });
  socket.disconnect();
}

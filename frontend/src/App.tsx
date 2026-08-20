import { FormEvent, useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { api, API_URL, ApiError } from './api';

type Role = 'CUSTOMER' | 'ORGANISER' | 'ADMIN';
type User = { id: string; name: string; email: string; role: Role };
type Category = { id: string; name: string; color: string };
type Event = { id: string; title: string; description?: string; type: 'MOVIE' | 'CONCERT'; startsAt: string; endsAt: string; venue: { name: string; city: string }; categoryPrices: Array<{ price: string | number; category: Category }> };
type Seat = { id: string; rowLabel: string; seatNumber: number; status: 'AVAILABLE' | 'HELD' | 'BOOKED'; price: string | number; category: Category };
type Hold = { id: string; expiresAt: string; seats: Array<{ id: string }> };
type Booking = { id: string; reference: string; status: string; totalAmount: string | number; createdAt: string; event: Event; seats: Array<{ showSeat: Seat }> };

const socketUrl = API_URL.replace(/\/api\/v1$/, '');
const money = (value: string | number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value));
const formatDate = (date: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));

export function App() {
  const [user, setUser] = useState<User | null>(() => JSON.parse(localStorage.getItem('ticketly_user') ?? 'null'));
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [page, setPage] = useState<'explore' | 'bookings' | 'workspace'>('explore');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const loadEvents = async () => {
    try { setEvents((await api<{ events: Event[] }>('/events')).events); } catch (err) { setError(message(err)); }
  };
  const loadSeats = async (event: Event) => {
    try {
      setSelectedEvent(event); setSelectedSeats([]); setHold(null); setError('');
      setSeats((await api<{ seats: Seat[] }>(`/events/${event.id}/seats`)).seats);
    } catch (err) { setError(message(err)); }
  };

  useEffect(() => { void loadEvents(); }, []);
  useEffect(() => {
    if (!selectedEvent) return;
    const socket: Socket = io(socketUrl);
    socket.emit('event:join', selectedEvent.id);
    socket.on('seat-map:changed', () => void loadSeats(selectedEvent));
    return () => { socket.emit('event:leave', selectedEvent.id); socket.disconnect(); };
  }, [selectedEvent?.id]);
  useEffect(() => {
    if (!hold) return;
    const update = () => setSeconds(Math.max(0, Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1000)));
    update(); const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [hold]);
  useEffect(() => {
    if (hold && seconds === 0) { setNotice('Your seat hold expired. Please choose seats again.'); setHold(null); if (selectedEvent) void loadSeats(selectedEvent); }
  }, [seconds, hold, selectedEvent]);

  const toggleSeat = (seat: Seat) => {
    if (seat.status !== 'AVAILABLE' || hold) return;
    setSelectedSeats((current) => current.includes(seat.id) ? current.filter((id) => id !== seat.id) : [...current, seat.id]);
  };
  const createHold = async () => {
    if (!user) return setAuthOpen(true);
    if (!selectedEvent || !selectedSeats.length) return;
    try {
      const response = await api<{ hold: Hold }>(`/events/${selectedEvent.id}/holds`, { method: 'POST', body: JSON.stringify({ seatIds: selectedSeats }) });
      setHold(response.hold); setNotice('Seats are reserved for you. Complete checkout before the timer ends.');
    } catch (err) { setError(message(err)); if (selectedEvent) void loadSeats(selectedEvent); }
  };
  const checkout = async () => {
    if (!hold) return;
    try {
      const response = await api<{ booking: Booking }>(`/holds/${hold.id}/checkout`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } });
      setNotice(`Booking confirmed — reference ${response.booking.reference}. Your QR ticket is being emailed.`);
      setHold(null); setSelectedSeats([]); if (selectedEvent) void loadSeats(selectedEvent);
    } catch (err) { setError(message(err)); }
  };
  const signOut = () => { localStorage.removeItem('ticketly_token'); localStorage.removeItem('ticketly_user'); setUser(null); setPage('explore'); };
  const selectedTotal = useMemo(() => seats.filter((seat) => selectedSeats.includes(seat.id)).reduce((sum, seat) => sum + Number(seat.price), 0), [seats, selectedSeats]);

  const showBookings = async () => { setPage('bookings'); try { setBookings((await api<{ bookings: Booking[] }>('/bookings')).bookings); } catch (err) { setError(message(err)); } };

  return <main>
    <header className="topbar"><button className="brand" onClick={() => { setSelectedEvent(null); setPage('explore'); }}>ticketly<span>.</span></button><nav><button onClick={() => { setSelectedEvent(null); setPage('explore'); }}>Explore</button>{user?.role === 'CUSTOMER' && <button onClick={showBookings}>My tickets</button>}{user && user.role !== 'CUSTOMER' && <button onClick={() => setPage('workspace')}>Workspace</button>}</nav><div>{user ? <><span className="user-name">Hi, {user.name.split(' ')[0]}</span><button className="button ghost" onClick={signOut}>Sign out</button></> : <button className="button" onClick={() => setAuthOpen(true)}>Sign in</button>}</div></header>
    {(error || notice) && <div className={`toast ${error ? 'error' : ''}`}>{error || notice}<button onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    {selectedEvent ? <EventDetail event={selectedEvent} seats={seats} selectedSeats={selectedSeats} hold={hold} seconds={seconds} total={selectedTotal} onBack={() => setSelectedEvent(null)} onSeat={toggleSeat} onHold={() => void createHold()} onCheckout={() => void checkout()} /> : page === 'bookings' ? <Bookings bookings={bookings} /> : page === 'workspace' && user ? <Workspace user={user} /> : <Explore events={events} onSelect={(event) => void loadSeats(event)} />}
    {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthenticated={(nextUser, token) => { localStorage.setItem('ticketly_user', JSON.stringify(nextUser)); localStorage.setItem('ticketly_token', token); setUser(nextUser); setAuthOpen(false); setNotice(`Welcome, ${nextUser.name}.`); }} />}
  </main>;
}

function Explore({ events, onSelect }: { events: Event[]; onSelect: (event: Event) => void }) {
  return <><section className="hero"><p className="eyebrow">Live moments, reserved fairly</p><h1>Find your next <em>unforgettable</em> night.</h1><p>Concerts and cinema, with live seats, transparent holds, and tickets that arrive ready to scan.</p></section><section className="content"><div className="section-heading"><div><p className="eyebrow">Now showing</p><h2>Events worth leaving home for</h2></div><span>{events.length} upcoming</span></div><div className="event-grid">{events.map((event) => <article className="event-card" key={event.id}><div className={`event-art ${event.type.toLowerCase()}`}><span>{event.type === 'CONCERT' ? '♫' : '◉'}</span><small>{event.type}</small></div><div className="event-copy"><p className="date">{formatDate(event.startsAt)}</p><h3>{event.title}</h3><p>{event.venue.name}, {event.venue.city}</p><div className="card-footer"><span>From {money(Math.min(...event.categoryPrices.map((price) => Number(price.price))))}</span><button className="text-button" onClick={() => onSelect(event)}>View seats →</button></div></div></article>)}</div>{!events.length && <p className="empty">No published events yet. Seed the database or publish an event from the organiser workspace.</p>}</section></>;
}

function EventDetail({ event, seats, selectedSeats, hold, seconds, total, onBack, onSeat, onHold, onCheckout }: { event: Event; seats: Seat[]; selectedSeats: string[]; hold: Hold | null; seconds: number; total: number; onBack: () => void; onSeat: (seat: Seat) => void; onHold: () => void; onCheckout: () => void }) {
  const rows = [...new Set(seats.map((seat) => seat.rowLabel))];
  return <section className="content booking-view"><button className="back" onClick={onBack}>← All events</button><div className="event-title"><div><p className="eyebrow">{event.type} · {formatDate(event.startsAt)}</p><h1>{event.title}</h1><p>{event.venue.name}, {event.venue.city}</p></div><div className="legend"><span><i className="available" />Available</span><span><i className="held" />Held</span><span><i className="booked" />Booked</span></div></div><div className="seat-layout"><div className="map"><div className="screen">STAGE / SCREEN</div>{rows.map((row) => <div className="seat-row" key={row}><b>{row}</b><div>{seats.filter((seat) => seat.rowLabel === row).map((seat) => <button key={seat.id} title={`${row}${seat.seatNumber} · ${money(seat.price)}`} className={`seat ${seat.status.toLowerCase()} ${selectedSeats.includes(seat.id) ? 'selected' : ''}`} onClick={() => onSeat(seat)}>{seat.seatNumber}</button>)}</div><b>{row}</b></div>)}</div><aside className="checkout"><p className="eyebrow">Your selection</p><h2>{hold ? 'Seats held' : `${selectedSeats.length} seat${selectedSeats.length === 1 ? '' : 's'} selected`}</h2>{hold ? <><div className="timer">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</div><p>Finish booking before your hold expires.</p><button className="button full" onClick={onCheckout}>Confirm booking · {money(total)}</button></> : <><div className="chosen-seats">{selectedSeats.length ? seats.filter((seat) => selectedSeats.includes(seat.id)).map((seat) => <span key={seat.id}>{seat.rowLabel}{seat.seatNumber}</span>) : <span>Select available seats on the map.</span>}</div><p className="total">Total <strong>{money(total)}</strong></p><button className="button full" disabled={!selectedSeats.length} onClick={onHold}>Hold these seats</button><small>Seats are held for 10 minutes. We never double-book.</small></>}</aside></div></section>;
}

function Bookings({ bookings }: { bookings: Booking[] }) { return <section className="content"><p className="eyebrow">My tickets</p><h1>Your bookings</h1><div className="booking-list">{bookings.map((booking) => <article key={booking.id} className="booking-card"><div><p className="date">{booking.reference} · {booking.status}</p><h3>{booking.event.title}</h3><p>{formatDate(booking.event.startsAt)} · {booking.seats.map((seat) => `${seat.showSeat.rowLabel}${seat.showSeat.seatNumber}`).join(', ')}</p></div><strong>{money(booking.totalAmount)}</strong></article>)}{!bookings.length && <p className="empty">Your confirmed tickets will appear here.</p>}</div></section>; }

function Workspace({ user }: { user: User }) { const [items, setItems] = useState<Array<{ id: string; name?: string; title?: string; status?: string; startsAt?: string }>>([]); const [message, setMessage] = useState(''); useEffect(() => { const path = user.role === 'ADMIN' ? '/admin/venues' : '/organiser/events'; void api<{ venues?: typeof items; events?: typeof items }>(path).then((data) => setItems(data.venues ?? data.events ?? [])).catch((err) => setMessage(messageOf(err))); }, [user.role]); return <section className="content"><p className="eyebrow">{user.role === 'ADMIN' ? 'Administration' : 'Organiser'}</p><h1>{user.role === 'ADMIN' ? 'Venue workspace' : 'Event workspace'}</h1><p className="workspace-note">Use the API documentation at <code>http://localhost:4000/docs</code> for the complete venue-layout and event-pricing workflow. This dashboard surfaces your current records.</p>{message && <p className="empty">{message}</p>}<div className="booking-list">{items.map((item) => <article className="booking-card" key={item.id}><div><p className="date">{item.status ?? 'VENUE'}</p><h3>{item.name ?? item.title}</h3><p>{item.startsAt ? formatDate(item.startsAt) : 'Configure categories and seats through the admin API.'}</p></div></article>)}</div></section>; }

function AuthModal({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (user: User, token: string) => void }) { const [mode, setMode] = useState<'login' | 'register'>('login'); const [form, setForm] = useState({ name: '', email: '', password: '', role: 'CUSTOMER' as Role }); const [error, setError] = useState(''); const submit = async (event: FormEvent) => { event.preventDefault(); try { const payload = mode === 'login' ? { email: form.email, password: form.password } : form; const response = await api<{ user: User; token: string }>(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(payload) }); onAuthenticated(response.user, response.token); } catch (err) { setError(message(err)); } }; return <div className="modal-backdrop"><form className="auth-modal" onSubmit={submit}><button type="button" className="close" onClick={onClose}>×</button><p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Create an account'}</p><h2>{mode === 'login' ? 'Pick up where you left off.' : 'Your next seat is waiting.'}</h2>{mode === 'register' && <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>}<label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Password<input required minLength={8} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>{mode === 'register' && <label>Account type<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}><option value="CUSTOMER">Customer</option><option value="ORGANISER">Organiser</option></select></label>}{error && <p className="form-error">{error}</p>}<button className="button full">{mode === 'login' ? 'Sign in' : 'Create account'}</button><button type="button" className="text-button switch" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}</button></form></div>; }

function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong.'; }
function messageOf(error: unknown) { return error instanceof ApiError ? error.message : message(error); }

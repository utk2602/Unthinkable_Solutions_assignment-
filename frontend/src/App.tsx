import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { io, Socket } from 'socket.io-client';
import { api, API_URL } from './api';
import { Workspace } from './Workspace';
import { Button, EmptyState, Icon, LoadingState, MetricCard, ModalShell, StatusBadge } from './components/UI';

type Role = 'CUSTOMER' | 'ORGANISER' | 'ADMIN';
type User = { id: string; name: string; email: string; role: Role };
type Category = { id: string; name: string; color: string };
type Event = { id: string; title: string; description?: string; type: 'MOVIE' | 'CONCERT'; startsAt: string; endsAt: string; venue: { name: string; city: string }; categoryPrices: Array<{ price: string | number; category: Category }> };
type Seat = { id: string; rowLabel: string; seatNumber: number; status: 'AVAILABLE' | 'HELD' | 'BOOKED'; price: string | number; category: Category };
type Hold = { id: string; eventId: string; expiresAt: string; seats: Seat[] };
type Booking = { id: string; reference: string; status: 'CONFIRMED' | 'CANCELLED'; totalAmount: string | number; createdAt: string; event: { id: string; title: string; startsAt: string; endsAt: string }; seats: Array<{ showSeat: Seat }> };
type Offer = { id: string; token: string; status: 'ACTIVE' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED'; expiresAt: string };
type WaitlistEntry = { id: string; quantity: number; status: 'WAITING' | 'OFFERED' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED'; event: { id: string; title: string; startsAt: string }; category: Category; offers: Offer[] };
type Page = 'explore' | 'bookings' | 'waitlist' | 'workspace';

const socketUrl = API_URL.replace(/\/api\/v1$/, '');
const money = (value: string | number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value));
const formatDate = (date: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
const shortDate = (date: string) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(date));
const shortTime = (date: string) => new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));

function offerTokenFromUrl() {
  const match = window.location.pathname.match(/^\/waitlist\/offer\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function App() {
  const [user, setUser] = useState<User | null>(() => readStoredUser());
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [checkoutKey, setCheckoutKey] = useState('');
  const [page, setPage] = useState<Page>(() => offerTokenFromUrl() ? 'waitlist' : 'explore');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [offerToken, setOfferToken] = useState(offerTokenFromUrl);
  const [ticket, setTicket] = useState<{ booking: Booking; qrCode: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authOpen, setAuthOpen] = useState(() => Boolean(offerTokenFromUrl() && !readStoredUser()));
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState('');
  const [eventsLoading, setEventsLoading] = useState(true);
  const [seatsLoading, setSeatsLoading] = useState(false);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('ticketly_theme') as 'light' | 'dark') || 'light');

  const loadEvents = async () => {
    setEventsLoading(true);
    try { setEvents((await api<{ events: Event[] }>('/events')).events); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setEventsLoading(false); }
  };
  const loadSeats = async (event: Event) => {
    setSeatsLoading(true);
    try { setSeats((await api<{ seats: Seat[] }>(`/events/${event.id}/seats`)).seats); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setSeatsLoading(false); }
  };
  const loadBookings = async () => {
    setBookingsLoading(true);
    try { setBookings((await api<{ bookings: Booking[] }>('/bookings')).bookings); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBookingsLoading(false); }
  };
  const loadWaitlist = async () => {
    setWaitlistLoading(true);
    try { setWaitlist((await api<{ entries: WaitlistEntry[] }>('/waitlist')).entries); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setWaitlistLoading(false); }
  };

  useEffect(() => { void loadEvents(); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ticketly_theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (!localStorage.getItem('ticketly_token')) return;
    void api<{ user: User }>('/auth/me').then(({ user: current }) => {
      localStorage.setItem('ticketly_user', JSON.stringify(current));
      setUser(current);
      if (offerToken && current.role === 'CUSTOMER') void loadWaitlist();
    }).catch(() => {
      localStorage.removeItem('ticketly_token');
      localStorage.removeItem('ticketly_user');
      setUser(null);
      if (offerToken) setAuthOpen(true);
    });
  }, []);
  useEffect(() => {
    if (!selectedEvent) return;
    const socket: Socket = io(socketUrl);
    socket.emit('event:join', selectedEvent.id);
    socket.on('seat-map:changed', () => void loadSeats(selectedEvent));
    return () => { socket.emit('event:leave', selectedEvent.id); socket.disconnect(); };
  }, [selectedEvent?.id]);
  useEffect(() => {
    if (!hold) { setSeconds(0); return; }
    const update = () => setSeconds(Math.max(0, Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1_000)));
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [hold?.id]);
  useEffect(() => {
    if (!hold || new Date(hold.expiresAt).getTime() > Date.now()) return;
    setNotice('Your seat hold expired. Select your seats again to continue.');
    setHold(null); setCheckoutKey(''); setSelectedSeats([]);
    if (selectedEvent) void loadSeats(selectedEvent);
  }, [seconds, hold?.id, selectedEvent?.id]);

  const releaseHold = async (silent = false) => {
    const active = hold;
    if (!active) return;
    setBusy('release');
    try {
      await api(`/holds/${active.id}`, { method: 'DELETE' });
      if (!silent) setNotice('Your hold was released.');
    } catch (caught) {
      if (!silent) setError(toMessage(caught));
    } finally {
      setHold(null); setCheckoutKey(''); setSelectedSeats([]); setBusy('');
      if (!silent && selectedEvent) void loadSeats(selectedEvent);
    }
  };
  const leaveEvent = async () => { await releaseHold(true); setSelectedEvent(null); };
  const navigate = async (nextPage: Page) => {
    await leaveEvent();
    setPage(nextPage); setError(''); setMobileOpen(false);
    if (nextPage !== 'waitlist' || !offerToken) window.history.replaceState({}, '', '/');
    if (nextPage === 'bookings' && user?.role === 'CUSTOMER') await loadBookings();
    if (nextPage === 'waitlist' && user?.role === 'CUSTOMER') await loadWaitlist();
  };
  const openEvent = async (event: Event) => {
    await releaseHold(true);
    setSelectedEvent(event); setSelectedSeats([]); setSeats([]); setError('');
    await loadSeats(event);
  };
  const toggleSeat = (seat: Seat) => {
    if (seat.status !== 'AVAILABLE' || hold) return;
    setSelectedSeats((current) => {
      if (current.includes(seat.id)) return current.filter((id) => id !== seat.id);
      if (current.length >= 8) { setError('You can reserve up to 8 seats per booking.'); return current; }
      return [...current, seat.id];
    });
  };
  const createHold = async () => {
    if (!user) { setAuthOpen(true); return; }
    if (user.role !== 'CUSTOMER') { setError('Only customer accounts can reserve seats.'); return; }
    if (!selectedEvent || !selectedSeats.length) return;
    setBusy('hold'); setError('');
    try {
      const response = await api<{ hold: Hold }>(`/events/${selectedEvent.id}/holds`, { method: 'POST', body: JSON.stringify({ seatIds: selectedSeats }) });
      setSeconds(Math.max(0, Math.ceil((new Date(response.hold.expiresAt).getTime() - Date.now()) / 1_000)));
      setCheckoutKey(crypto.randomUUID()); setHold(response.hold);
      setNotice('Seats secured. Complete checkout before the timer ends.');
    } catch (caught) {
      setError(toMessage(caught)); setSelectedSeats([]); setHold(null); setCheckoutKey('');
      if (selectedEvent) void loadSeats(selectedEvent);
    } finally { setBusy(''); }
  };
  const checkout = async () => {
    if (!hold || !checkoutKey) return;
    setBusy('checkout'); setError('');
    try {
      const response = await api<{ booking: Booking; qrCode: string }>(`/holds/${hold.id}/checkout`, { method: 'POST', headers: { 'Idempotency-Key': checkoutKey } });
      setTicket(response); setNotice(`Booking ${response.booking.reference} is confirmed. Your QR ticket is queued for email.`);
      setHold(null); setCheckoutKey(''); setSelectedSeats([]);
      if (selectedEvent) void loadSeats(selectedEvent);
    } catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const joinWaitlist = async (categoryId: string) => {
    if (!user) { setAuthOpen(true); return; }
    if (user.role !== 'CUSTOMER' || !selectedEvent) { setError('Only customer accounts can join a waitlist.'); return; }
    setBusy(`waitlist-${categoryId}`);
    try {
      await api(`/events/${selectedEvent.id}/waitlist`, { method: 'POST', body: JSON.stringify({ categoryId, quantity: 1 }) });
      setNotice('You are on the waitlist. We will email you when a seat opens.');
    } catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const cancelBooking = async (bookingId: string) => {
    setBusy(`cancel-${bookingId}`);
    try { await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: '{}' }); setNotice('Booking cancelled. The seats are available to the next customer.'); await loadBookings(); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const viewTicket = async (bookingId: string) => {
    setBusy(`ticket-${bookingId}`);
    try { setTicket(await api<{ booking: Booking; qrCode: string }>(`/bookings/${bookingId}`)); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const acceptOffer = async (token: string) => {
    setBusy(`offer-${token}`);
    try {
      const response = await api<{ booking: Booking; qrCode: string }>(`/waitlist/offers/${encodeURIComponent(token)}/accept`, { method: 'POST', body: '{}' });
      setTicket(response); setNotice(`Offer accepted. Booking ${response.booking.reference} is confirmed.`);
      setOfferToken(''); window.history.replaceState({}, '', '/'); await loadWaitlist();
    } catch (caught) { setError(toMessage(caught)); await loadWaitlist(); }
    finally { setBusy(''); }
  };
  const leaveWaitlist = async (entryId: string) => {
    setBusy(`leave-${entryId}`);
    try { await api(`/waitlist/${entryId}`, { method: 'DELETE' }); setNotice('You left the waitlist.'); await loadWaitlist(); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const signOut = async () => {
    await releaseHold(true);
    localStorage.removeItem('ticketly_token'); localStorage.removeItem('ticketly_user');
    setUser(null); setBookings([]); setWaitlist([]); setOfferToken(''); setPage('explore'); setSelectedEvent(null);
    window.history.replaceState({}, '', '/');
  };
  const authenticated = (nextUser: User, token: string) => {
    localStorage.setItem('ticketly_user', JSON.stringify(nextUser)); localStorage.setItem('ticketly_token', token);
    setUser(nextUser); setAuthOpen(false); setNotice(`Welcome back, ${nextUser.name.split(' ')[0]}.`);
    if (offerToken && nextUser.role === 'CUSTOMER') { setPage('waitlist'); void loadWaitlist(); }
    else if (offerToken) setError('Sign in with the customer account that owns this offer.');
  };

  const selectedTotal = useMemo(() => seats.filter((seat) => selectedSeats.includes(seat.id)).reduce((sum, seat) => sum + Number(seat.price), 0), [seats, selectedSeats]);
  const customerNav = user?.role === 'CUSTOMER';

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" aria-label="Ticketly home" onClick={() => void navigate('explore')}><span className="brand-mark"><Icon name="ticket" size={19} /></span><span>ticketly</span></button>
      <nav className={mobileOpen ? 'open' : ''} aria-label="Primary navigation">
        <NavButton active={!selectedEvent && page === 'explore'} icon="compass" onClick={() => void navigate('explore')}>Discover</NavButton>
        {customerNav && <NavButton active={!selectedEvent && page === 'bookings'} icon="ticket" onClick={() => void navigate('bookings')}>My tickets</NavButton>}
        {customerNav && <NavButton active={!selectedEvent && page === 'waitlist'} icon="bell" onClick={() => void navigate('waitlist')}>Waitlist</NavButton>}
        {user && !customerNav && <NavButton active={page === 'workspace'} icon="grid" onClick={() => void navigate('workspace')}>Workspace</NavButton>}
      </nav>
      <div className="topbar-actions">
        <button className="icon-button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>
        {user ? <div className="profile-cluster"><span className="avatar">{initials(user.name)}</span><span className="profile-copy"><strong>{user.name}</strong><small>{user.role.toLowerCase()}</small></span><Button variant="quiet" size="sm" onClick={() => void signOut()}>Sign out</Button></div> : <Button size="sm" icon="user" onClick={() => setAuthOpen(true)}>Sign in</Button>}
        <button className="icon-button menu-button" aria-label="Toggle navigation" onClick={() => setMobileOpen(!mobileOpen)}><Icon name={mobileOpen ? 'close' : 'menu'} /></button>
      </div>
    </header>

    {(error || notice) && <div className={`toast ${error ? 'error' : 'success'}`} role="status"><span className="toast-icon"><Icon name={error ? 'close' : 'check'} size={15} /></span><p>{error || notice}</p><button className="icon-button" aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" size={15} /></button></div>}

    <main>
      {selectedEvent
        ? <EventDetail event={selectedEvent} seats={seats} loading={seatsLoading} selectedSeats={selectedSeats} hold={hold} seconds={seconds} total={selectedTotal} busy={busy} onBack={() => void leaveEvent()} onSeat={toggleSeat} onHold={() => void createHold()} onRelease={() => void releaseHold()} onCheckout={() => void checkout()} onWaitlist={(id) => void joinWaitlist(id)} />
        : page === 'bookings' && customerNav
          ? <Bookings bookings={bookings} loading={bookingsLoading} busy={busy} onCancel={cancelBooking} onTicket={(id) => void viewTicket(id)} onExplore={() => void navigate('explore')} />
          : page === 'waitlist' && customerNav
            ? <Waitlist entries={waitlist} loading={waitlistLoading} busy={busy} linkedToken={offerToken} onAccept={(token) => void acceptOffer(token)} onLeave={(id) => void leaveWaitlist(id)} onExplore={() => void navigate('explore')} />
            : page === 'workspace' && user && !customerNav
              ? <Workspace user={user} />
              : <Explore events={events} loading={eventsLoading} onSelect={(event) => void openEvent(event)} />}
    </main>

    {customerNav && <nav className="mobile-dock" aria-label="Mobile navigation"><NavButton active={page === 'explore'} icon="compass" onClick={() => void navigate('explore')}>Discover</NavButton><NavButton active={page === 'bookings'} icon="ticket" onClick={() => void navigate('bookings')}>Tickets</NavButton><NavButton active={page === 'waitlist'} icon="bell" onClick={() => void navigate('waitlist')}>Waitlist</NavButton></nav>}
    {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthenticated={authenticated} />}
    {ticket && <TicketModal ticket={ticket} onClose={() => setTicket(null)} />}
  </div>;
}

function NavButton({ active, icon, children, onClick }: { active: boolean; icon: 'compass' | 'ticket' | 'bell' | 'grid'; children: string; onClick: () => void }) {
  return <button className={active ? 'nav-button active' : 'nav-button'} onClick={onClick}><Icon name={icon} size={17} /><span>{children}</span></button>;
}

function Explore({ events, loading, onSelect }: { events: Event[]; loading: boolean; onSelect: (event: Event) => void }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'ALL' | Event['type']>('ALL');
  const filtered = events.filter((event) => (type === 'ALL' || event.type === type) && `${event.title} ${event.venue.name} ${event.venue.city}`.toLowerCase().includes(query.toLowerCase()));
  const featured = filtered[0];
  return <>
    <section className="hero-section">
      <div className="hero-grid page-width">
        <div className="hero-copy">
          <span className="section-kicker"><Icon name="sparkles" size={14} /> Live inventory. Zero guesswork.</span>
          <h1>Make room for<br /><em>something live.</em></h1>
          <p>Book movies and concerts from a real-time seat map. Your seats stay protected while you check out, and every ticket lands in your inbox with a QR code.</p>
          <div className="hero-actions">{featured && <Button size="lg" icon="arrow-right" onClick={() => onSelect(featured)}>Explore the next show</Button>}<span className="live-proof"><i /> Seat maps update live</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="fluid-orb"><span /><span /><span /></div>
          <div className="floating-ticket ticket-one"><small>UP NEXT</small><strong>{featured?.title ?? 'Your next night out'}</strong><span>{featured ? shortDate(featured.startsAt) : 'Coming soon'}</span></div>
          <div className="floating-ticket ticket-two"><Icon name="shield" /><span><strong>10 min</strong><small>protected hold</small></span></div>
        </div>
      </div>
    </section>

    <section className="discovery-section page-width">
      <div className="section-heading"><div><span className="section-kicker">Curated for now</span><h2>Find your next story</h2></div><p>{filtered.length} upcoming event{filtered.length === 1 ? '' : 's'}</p></div>
      <div className="filter-bar"><label className="search-field"><Icon name="search" /><input aria-label="Search events" placeholder="Search event, venue, or city" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>Search</kbd></label><div className="filter-segments" role="group" aria-label="Event type"><button className={type === 'ALL' ? 'active' : ''} onClick={() => setType('ALL')}>All</button><button className={type === 'CONCERT' ? 'active' : ''} onClick={() => setType('CONCERT')}><Icon name="music" size={14} />Concerts</button><button className={type === 'MOVIE' ? 'active' : ''} onClick={() => setType('MOVIE')}><Icon name="film" size={14} />Movies</button></div></div>
      {loading ? <div className="loading-panel"><LoadingState label="Finding live events" /></div> : filtered.length ? <div className="event-grid">{filtered.map((event, index) => <EventCard key={event.id} event={event} index={index} onSelect={onSelect} />)}</div> : <EmptyState icon="search" title="No matching events" copy="Try a broader search or switch the event type filter." />}
      <div className="trust-row"><div><Icon name="shield" /><span><strong>Concurrency safe</strong><small>No double-booked seats</small></span></div><div><Icon name="clock" /><span><strong>Fair 10-minute holds</strong><small>Enough time to check out</small></span></div><div><Icon name="ticket" /><span><strong>QR tickets by email</strong><small>Ready when doors open</small></span></div></div>
    </section>
  </>;
}

function EventCard({ event, index, onSelect }: { event: Event; index: number; onSelect: (event: Event) => void }) {
  const price = Math.min(...event.categoryPrices.map((item) => Number(item.price)));
  return <article className="event-card" onClick={() => onSelect(event)}>
    <div className={`event-poster poster-${index % 3}`}><span className="poster-grid" /><span className="poster-orb" /><div className="poster-top"><span className="event-type"><Icon name={event.type === 'CONCERT' ? 'music' : 'film'} size={14} />{event.type}</span><span className="date-tile"><strong>{shortDate(event.startsAt).split(' ')[0]}</strong><small>{shortDate(event.startsAt).split(' ')[1]}</small></span></div><Icon name={event.type === 'CONCERT' ? 'music' : 'film'} size={56} strokeWidth={1.2} /></div>
    <div className="event-card-body"><p className="event-meta"><span><Icon name="calendar" size={14} />{formatDate(event.startsAt)}</span></p><h3>{event.title}</h3><p className="venue-line"><Icon name="map-pin" size={14} />{event.venue.name}, {event.venue.city}</p><div className="event-card-footer"><span><small>starts at</small><strong>{money(price)}</strong></span><button className="round-arrow" aria-label={`View seats for ${event.title}`}><Icon name="arrow-right" /></button></div></div>
  </article>;
}

function EventDetail({ event, seats, loading, selectedSeats, hold, seconds, total, busy, onBack, onSeat, onHold, onRelease, onCheckout, onWaitlist }: { event: Event; seats: Seat[]; loading: boolean; selectedSeats: string[]; hold: Hold | null; seconds: number; total: number; busy: string; onBack: () => void; onSeat: (seat: Seat) => void; onHold: () => void; onRelease: () => void; onCheckout: () => void; onWaitlist: (categoryId: string) => void }) {
  const rows = [...new Set(seats.map((seat) => seat.rowLabel))];
  const selected = seats.filter((seat) => selectedSeats.includes(seat.id));
  const soldOut = event.categoryPrices.filter(({ category }) => { const categorySeats = seats.filter((seat) => seat.category.id === category.id); return categorySeats.length > 0 && categorySeats.every((seat) => seat.status !== 'AVAILABLE'); });
  const available = seats.filter((seat) => seat.status === 'AVAILABLE').length;
  return <section className="booking-page page-width">
    <button className="back-button" onClick={onBack}><Icon name="arrow-left" />Back to events</button>
    <div className="event-detail-header"><div><span className="section-kicker"><Icon name={event.type === 'CONCERT' ? 'music' : 'film'} size={14} />{event.type}</span><h1>{event.title}</h1><p><span><Icon name="calendar" />{formatDate(event.startsAt)}</span><span><Icon name="map-pin" />{event.venue.name}, {event.venue.city}</span></p></div><div className="availability-card"><span className="live-dot"><i />Live</span><strong>{available}</strong><small>seats available</small></div></div>
    <div className="booking-steps"><span className={!hold ? 'active' : 'complete'}><i>{hold ? <Icon name="check" size={12} /> : '1'}</i>Select seats</span><b /><span className={hold ? 'active' : ''}><i>2</i>Review hold</span><b /><span><i>3</i>Get ticket</span></div>
    <div className="seat-layout">
      <div className="seat-map-card">
        <div className="map-toolbar"><div className="seat-legend"><span><i className="available" />Available</span><span><i className="selected" />Selected</span><span><i className="held" />Held</span><span><i className="booked" />Booked</span></div><div className="category-legend">{event.categoryPrices.map(({ category, price }) => <span key={category.id}><i style={{ background: category.color }} />{category.name} {money(price)}</span>)}</div></div>
        <div className="theater-map"><div className="screen"><span>STAGE / SCREEN</span></div>{loading ? <LoadingState label="Syncing seat map" /> : rows.map((row) => <div className="seat-row" key={row}><b>{row}</b><div>{seats.filter((seat) => seat.rowLabel === row).map((seat) => <button aria-label={`Seat ${row}${seat.seatNumber}, ${seat.status.toLowerCase()}, ${money(seat.price)}`} key={seat.id} title={`${seat.category.name} / ${money(seat.price)}`} className={`seat ${seat.status.toLowerCase()} ${selectedSeats.includes(seat.id) ? 'selected' : ''}`} disabled={seat.status !== 'AVAILABLE' || Boolean(hold)} onClick={() => onSeat(seat)}><span>{seat.seatNumber}</span></button>)}</div><b>{row}</b></div>)}</div>
      </div>
      <aside className="checkout-card">
        <div className="checkout-heading"><span className="section-kicker">Your booking</span><StatusBadge status={hold ? 'HELD' : selected.length ? 'SELECTING' : 'READY'} /></div>
        {hold ? <div className="hold-state"><div className="timer-ring" style={{ '--progress': `${Math.min(100, seconds / 6)}%` } as CSSProperties}><strong>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</strong><small>remaining</small></div><h2>Your seats are protected</h2><p>Checkout now. If the timer ends, these seats return to the live map automatically.</p><SeatSummary seats={selected} /><div className="price-total"><span>Total</span><strong>{money(total)}</strong></div><Button className="full" size="lg" icon="ticket" disabled={busy === 'checkout'} onClick={onCheckout}>{busy === 'checkout' ? 'Confirming...' : 'Confirm & get QR ticket'}</Button><Button className="full" variant="quiet" disabled={busy === 'release'} onClick={onRelease}>Release these seats</Button></div> : <><div className="selection-state"><span className="selection-count">{selected.length}<small>/ 8 seats</small></span><h2>{selected.length ? 'Great seats.' : 'Choose your view.'}</h2><p>{selected.length ? 'Review your seats and secure them for checkout.' : 'Tap any available seat on the live map to begin.'}</p><SeatSummary seats={selected} /><div className="price-total"><span>Total</span><strong>{money(total)}</strong></div><Button className="full" size="lg" icon="shield" disabled={!selected.length || busy === 'hold'} onClick={onHold}>{busy === 'hold' ? 'Securing seats...' : 'Hold selected seats'}</Button><small className="safety-note"><Icon name="shield" size={14} />No payment is taken during the hold.</small></div>{soldOut.length > 0 && <div className="waitlist-prompt"><span className="approval-icon"><Icon name="bell" /></span><div><strong>Sold out right now</strong><p>Join the category queue and get a timed offer when a seat opens.</p></div>{soldOut.map(({ category }) => <Button key={category.id} variant="secondary" size="sm" disabled={busy === `waitlist-${category.id}`} onClick={() => onWaitlist(category.id)}>Join {category.name}</Button>)}</div>}</>}
      </aside>
    </div>
  </section>;
}

function SeatSummary({ seats }: { seats: Seat[] }) {
  return <div className="seat-summary">{seats.length ? seats.map((seat) => <span key={seat.id}><strong>{seat.rowLabel}{seat.seatNumber}</strong><small>{seat.category.name}</small></span>) : <div className="selection-placeholder"><Icon name="grid" /><span>Selected seats appear here</span></div>}</div>;
}

function Bookings({ bookings, loading, busy, onCancel, onTicket, onExplore }: { bookings: Booking[]; loading: boolean; busy: string; onCancel: (id: string) => Promise<void>; onTicket: (id: string) => void; onExplore: () => void }) {
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const confirmed = bookings.filter((booking) => booking.status === 'CONFIRMED');
  const upcoming = confirmed.filter((booking) => new Date(booking.event.startsAt) > new Date());
  const spent = confirmed.reduce((sum, booking) => sum + Number(booking.totalAmount), 0);
  return <section className="account-page page-width">
    <PageHeading kicker="Ticket wallet" title="Your nights out, together." copy="Open a QR ticket, review your seats, or cancel an upcoming booking." />
    <div className="metrics-row"><MetricCard icon="ticket" label="Upcoming" value={upcoming.length} detail="confirmed bookings" /><MetricCard icon="grid" label="Seats booked" value={confirmed.reduce((sum, booking) => sum + booking.seats.length, 0)} detail="across all events" /><MetricCard icon="wallet" label="Ticket value" value={money(spent)} detail="confirmed total" /></div>
    {loading ? <div className="loading-panel"><LoadingState label="Opening your ticket wallet" /></div> : bookings.length ? <div className="ticket-list">{bookings.map((booking) => <article className={`booking-ticket ${booking.status.toLowerCase()}`} key={booking.id}><div className="ticket-stub"><span className="ticket-date"><strong>{shortDate(booking.event.startsAt).split(' ')[0]}</strong><small>{shortDate(booking.event.startsAt).split(' ')[1]}</small></span><i /><span>{shortTime(booking.event.startsAt)}</span></div><div className="ticket-main"><div className="ticket-main-top"><StatusBadge status={booking.status} /><code>{booking.reference}</code></div><h2>{booking.event.title}</h2><div className="ticket-detail-grid"><span><small>Date & time</small><strong>{formatDate(booking.event.startsAt)}</strong></span><span><small>Your seats</small><strong>{booking.seats.map((seat) => `${seat.showSeat.rowLabel}${seat.showSeat.seatNumber}`).join(', ')}</strong></span><span><small>Total paid</small><strong>{money(booking.totalAmount)}</strong></span></div><div className="ticket-actions"><Button icon="ticket" disabled={busy === `ticket-${booking.id}`} onClick={() => onTicket(booking.id)}>{busy === `ticket-${booking.id}` ? 'Opening...' : 'Open QR ticket'}</Button>{booking.status === 'CONFIRMED' && new Date(booking.event.startsAt) > new Date() && <Button variant="quiet" onClick={() => setCancelTarget(booking)}>Cancel booking</Button>}</div></div></article>)}</div> : <EmptyState icon="ticket" title="Your ticket wallet is empty" copy="Discover a live event, choose your seats, and your QR ticket will appear here." action={<Button icon="compass" onClick={onExplore}>Discover events</Button>} />}
    {cancelTarget && <ModalShell onClose={() => setCancelTarget(null)} labelledBy="cancel-title"><div className="confirmation-modal"><span className="danger-icon"><Icon name="trash" /></span><span className="section-kicker">Release booking</span><h2 id="cancel-title">Cancel {cancelTarget.event.title}?</h2><p>Your seats will be released immediately and may be offered to the next person on the waitlist. This cannot be undone.</p><div className="modal-actions"><Button variant="secondary" onClick={() => setCancelTarget(null)}>Keep booking</Button><Button variant="danger" disabled={busy === `cancel-${cancelTarget.id}`} onClick={async () => { await onCancel(cancelTarget.id); setCancelTarget(null); }}>{busy === `cancel-${cancelTarget.id}` ? 'Cancelling...' : 'Yes, cancel booking'}</Button></div></div></ModalShell>}
  </section>;
}

function Waitlist({ entries, loading, busy, linkedToken, onAccept, onLeave, onExplore }: { entries: WaitlistEntry[]; loading: boolean; busy: string; linkedToken: string; onAccept: (token: string) => void; onLeave: (id: string) => void; onExplore: () => void }) {
  const active = entries.filter((entry) => entry.status === 'WAITING' || entry.status === 'OFFERED');
  const offers = entries.filter((entry) => entry.offers.some((offer) => offer.status === 'ACTIVE'));
  return <section className="account-page page-width">
    <PageHeading kicker="Fair access" title="Your waitlist." copy="We move category queues in order. When your turn arrives, you get a protected, time-limited offer by email." />
    <div className="metrics-row"><MetricCard icon="bell" label="Active queues" value={active.length} detail="waiting for a seat" /><MetricCard icon="clock" label="Offers ready" value={offers.length} detail="action may be needed" /><MetricCard icon="shield" label="Queue policy" value="FIFO" detail="oldest request first" /></div>
    {loading ? <div className="loading-panel"><LoadingState label="Checking your queues" /></div> : entries.length ? <div className="waitlist-list">{entries.map((entry) => { const activeOffer = entry.offers.find((offer) => offer.status === 'ACTIVE'); const linked = activeOffer?.token === linkedToken; return <article className={`waitlist-row ${activeOffer ? 'has-offer' : ''} ${linked ? 'highlight' : ''}`} key={entry.id}><div className="queue-rail"><span className={entry.status === 'WAITING' ? 'active' : 'complete'}><Icon name="check" /></span><i /><span className={entry.status === 'OFFERED' ? 'active' : entry.status === 'FULFILLED' ? 'complete' : ''}>{entry.status === 'OFFERED' || entry.status === 'FULFILLED' ? <Icon name="check" /> : '2'}</span><i /><span className={entry.status === 'FULFILLED' ? 'complete' : ''}>{entry.status === 'FULFILLED' ? <Icon name="check" /> : '3'}</span></div><div className="queue-copy"><div className="queue-title"><div><StatusBadge status={entry.status} />{linked && <span className="email-link-badge"><Icon name="sparkles" size={12} />Opened from email</span>}</div><h2>{entry.event.title}</h2><p><Icon name="calendar" />{formatDate(entry.event.startsAt)}<span />{entry.category.name} category</p></div>{activeOffer ? <div className="offer-approval"><span className="approval-icon"><Icon name="ticket" /></span><div><strong>A seat is ready for you</strong><p>This seat is protected until the offer timer ends.</p><OfferCountdown expiresAt={activeOffer.expiresAt} /></div><Button icon="check" disabled={busy === `offer-${activeOffer.token}`} onClick={() => onAccept(activeOffer.token)}>{busy === `offer-${activeOffer.token}` ? 'Confirming...' : 'Accept offer'}</Button></div> : <div className="queue-status-copy"><span className="pulse-orbit"><i /></span><div><strong>{entry.status === 'WAITING' ? 'Waiting fairly in line' : 'This queue is complete'}</strong><p>{entry.status === 'WAITING' ? 'We will email you the moment your protected offer is created.' : 'No action is needed for this entry.'}</p></div></div>}<div className="queue-footer"><span>Requested {entry.quantity} seat in {entry.category.name}</span>{(entry.status === 'WAITING' || entry.status === 'OFFERED') && <Button variant="quiet" size="sm" disabled={busy === `leave-${entry.id}`} onClick={() => onLeave(entry.id)}>Leave queue</Button>}</div></div></article>; })}</div> : <EmptyState icon="bell" title="No waitlists yet" copy="When a category has no available seats, join its queue directly from the live seat map." action={<Button icon="compass" onClick={onExplore}>Explore sold-out events</Button>} />}
  </section>;
}

function OfferCountdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1_000)));
  useEffect(() => { const interval = window.setInterval(() => setRemaining(Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1_000))), 1_000); return () => window.clearInterval(interval); }, [expiresAt]);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return <span className="offer-countdown"><Icon name="clock" size={14} />{minutes}:{String(seconds).padStart(2, '0')} remaining</span>;
}

function PageHeading({ kicker, title, copy }: { kicker: string; title: string; copy: string }) {
  return <div className="page-heading"><span className="section-kicker">{kicker}</span><h1>{title}</h1><p>{copy}</p></div>;
}

function TicketModal({ ticket, onClose }: { ticket: { booking: Booking; qrCode: string }; onClose: () => void }) {
  return <ModalShell onClose={onClose} labelledBy="ticket-title"><div className="qr-ticket"><div className="qr-ticket-header"><span className="brand-mark"><Icon name="ticket" /></span><StatusBadge status={ticket.booking.status} /></div><span className="section-kicker">Ready to scan</span><h2 id="ticket-title">{ticket.booking.event.title}</h2><p>{formatDate(ticket.booking.event.startsAt)}</p><div className="qr-frame"><span className="scan-corner one" /><span className="scan-corner two" /><span className="scan-corner three" /><span className="scan-corner four" /><img src={ticket.qrCode} alt={`QR ticket for ${ticket.booking.reference}`} /></div><code>{ticket.booking.reference}</code><div className="qr-seats">{ticket.booking.seats.map((seat) => <span key={seat.showSeat.id}><small>Seat</small><strong>{seat.showSeat.rowLabel}{seat.showSeat.seatNumber}</strong></span>)}</div><p className="qr-help"><Icon name="shield" />Show this code at the venue entrance. The QR contains your booking reference.</p></div></ModalShell>;
}

function AuthModal({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (user: User, token: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'CUSTOMER' as Role });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError('');
    try { const payload = mode === 'login' ? { email: form.email, password: form.password } : form; const response = await api<{ user: User; token: string }>(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(payload) }); onAuthenticated(response.user, response.token); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setSubmitting(false); }
  };
  const fillDemo = (role: 'CUSTOMER' | 'ORGANISER' | 'ADMIN') => setForm({ ...form, email: `${role.toLowerCase()}@ticketly.test`, password: 'DemoPass123!' });
  return <ModalShell onClose={onClose} labelledBy="auth-title" size="wide"><div className="auth-layout"><div className="auth-visual"><div className="auth-orb" /><span className="section-kicker"><Icon name="sparkles" size={14} />Ticketly access</span><h2>One account.<br />Every live moment.</h2><p>Protected seat holds, fair waitlists, and QR tickets that are always within reach.</p><div className="auth-proof"><span><Icon name="shield" />Secure booking</span><span><Icon name="bell" />Smart waitlists</span></div></div><form className="auth-form" onSubmit={submit}><div className="auth-tabs"><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Sign in</button><button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>Create account</button></div><span className="section-kicker">{mode === 'login' ? 'Welcome back' : 'Join Ticketly'}</span><h2 id="auth-title">{mode === 'login' ? 'Continue your night out.' : 'Start with an account.'}</h2><p>{mode === 'login' ? 'Sign in to manage tickets, holds, and offers.' : 'Choose your role and we will set up the right workspace.'}</p>{mode === 'register' && <label><span>Full name</span><div className="input-shell"><Icon name="user" /><input required autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" /></div></label>}<label><span>Email address</span><div className="input-shell"><span className="input-at">@</span><input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></div></label><label><span>Password</span><div className="input-shell"><Icon name="shield" /><input required minLength={8} type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="At least 8 characters" /><button type="button" className="icon-button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}><Icon name={showPassword ? 'eye-off' : 'eye'} size={17} /></button></div></label>{mode === 'register' && <fieldset className="role-picker"><legend>Account type</legend><button type="button" className={form.role === 'CUSTOMER' ? 'active' : ''} onClick={() => setForm({ ...form, role: 'CUSTOMER' })}><Icon name="ticket" /><span><strong>Customer</strong><small>Book and manage tickets</small></span></button><button type="button" className={form.role === 'ORGANISER' ? 'active' : ''} onClick={() => setForm({ ...form, role: 'ORGANISER' })}><Icon name="grid" /><span><strong>Organiser</strong><small>Create and report on events</small></span></button></fieldset>}{error && <p className="form-error"><Icon name="close" size={14} />{error}</p>}<Button className="full" size="lg" icon="arrow-right" disabled={submitting}>{submitting ? 'Please wait...' : mode === 'login' ? 'Sign in securely' : 'Create my account'}</Button>{mode === 'login' && <div className="demo-access"><span>Assignment demo access</span><div><button type="button" onClick={() => fillDemo('CUSTOMER')}>Customer</button><button type="button" onClick={() => fillDemo('ORGANISER')}>Organiser</button><button type="button" onClick={() => fillDemo('ADMIN')}>Admin</button></div></div>}</form></div></ModalShell>;
}

function initials(name: string) { return name.split(' ').slice(0, 2).map((part) => part[0]).join('').toUpperCase(); }
function readStoredUser(): User | null { try { return JSON.parse(localStorage.getItem('ticketly_user') ?? 'null') as User | null; } catch { localStorage.removeItem('ticketly_user'); return null; } }
function toMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong.'; }

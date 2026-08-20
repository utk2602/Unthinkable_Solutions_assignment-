import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import { Button, EmptyState, Icon, LoadingState, MetricCard, StatusBadge } from './components/UI';

type Role = 'CUSTOMER' | 'ORGANISER' | 'ADMIN';
type User = { id: string; name: string; email: string; role: Role };
type Category = { id: string; name: string; color: string; sortOrder: number };
type VenueSeat = { id: string; rowLabel: string; seatNumber: number; category?: Category };
type Venue = { id: string; name: string; address: string; city: string; categories: Category[]; seats?: VenueSeat[]; _count?: { seats: number; events?: number } };
type OrganiserEvent = { id: string; title: string; description?: string; type: 'CONCERT' | 'MOVIE'; status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED'; startsAt: string; endsAt: string; venue: { name: string }; venueId?: string; categoryPrices: Array<{ price: string | number; category: Category; categoryId?: string }> };
type Report = { eventId: string; confirmedBookings: number; seatsSold: number; totalSeats: number; occupancyPercent: number; revenue: number; revenueByCategory: Record<string, { seatsSold: number; revenue: number }> };

const money = (value: string | number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value));
const formatDate = (date: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));

export function Workspace({ user }: { user: User }) {
  return user.role === 'ADMIN' ? <AdminWorkspace /> : <OrganiserWorkspace />;
}

function AdminWorkspace() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [selected, setSelected] = useState<Venue | null>(null);
  const [venueForm, setVenueForm] = useState({ name: '', address: '', city: '' });
  const [editForm, setEditForm] = useState({ name: '', address: '', city: '' });
  const [categoryForm, setCategoryForm] = useState({ name: '', color: '#FC4C01' });
  const [seatForm, setSeatForm] = useState({ rowLabel: 'A', count: 8, categoryId: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');

  const loadVenues = async () => setVenues((await api<{ venues: Venue[] }>('/admin/venues')).venues);
  const loadVenue = async (id: string) => {
    const response = await api<{ venue: Venue }>(`/admin/venues/${id}`);
    setSelected(response.venue);
    setEditForm({ name: response.venue.name, address: response.venue.address, city: response.venue.city });
    setSeatForm((current) => ({ ...current, categoryId: response.venue.categories.some((category) => category.id === current.categoryId) ? current.categoryId : response.venue.categories[0]?.id || '' }));
  };
  useEffect(() => {
    void loadVenues().catch((caught) => setError(toMessage(caught))).finally(() => setLoading(false));
  }, []);

  const createVenue = async (event: FormEvent) => {
    event.preventDefault(); setBusy('create'); setError('');
    try {
      const response = await api<{ venue: Venue }>('/admin/venues', { method: 'POST', body: JSON.stringify(venueForm) });
      setVenueForm({ name: '', address: '', city: '' }); setShowCreate(false);
      await loadVenues(); await loadVenue(response.venue.id); setMessage('Venue created. Add categories and seat rows to complete the layout.');
    } catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const updateVenue = async (event: FormEvent) => {
    event.preventDefault(); if (!selected) return; setBusy('edit'); setError('');
    try { await api(`/admin/venues/${selected.id}`, { method: 'PATCH', body: JSON.stringify(editForm) }); await loadVenue(selected.id); await loadVenues(); setMessage('Venue details updated.'); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const addCategory = async (event: FormEvent) => {
    event.preventDefault(); if (!selected) return; setBusy('category'); setError('');
    try { await api(`/admin/venues/${selected.id}/categories`, { method: 'POST', body: JSON.stringify(categoryForm) }); setCategoryForm({ name: '', color: '#FC4C01' }); await loadVenue(selected.id); await loadVenues(); setMessage('Seat category added.'); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const addSeatRow = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !seatForm.categoryId) return; setBusy('seats'); setError('');
    const rowLabel = seatForm.rowLabel.trim().toUpperCase();
    const lastSeatNumber = Math.max(0, ...(selected.seats ?? []).filter((seat) => seat.rowLabel === rowLabel).map((seat) => seat.seatNumber));
    const seats = Array.from({ length: seatForm.count }, (_, index) => ({ rowLabel, seatNumber: lastSeatNumber + index + 1, categoryId: seatForm.categoryId }));
    try { await api(`/admin/venues/${selected.id}/seats`, { method: 'POST', body: JSON.stringify({ seats }) }); await loadVenue(selected.id); await loadVenues(); setMessage(`Added ${seats.length} seats to row ${rowLabel}.`); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };

  const filtered = venues.filter((venue) => `${venue.name} ${venue.city}`.toLowerCase().includes(query.toLowerCase()));
  const totalSeats = venues.reduce((sum, venue) => sum + (venue._count?.seats ?? 0), 0);
  const totalCategories = venues.reduce((sum, venue) => sum + venue.categories.length, 0);

  return <section className="workspace-page page-width">
    <WorkspaceHeader kicker="Admin control" title="Venue operations" copy="Create venues, define price categories, and build reusable seat layouts for organisers." action={<Button icon={showCreate ? 'close' : 'plus'} onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Close form' : 'New venue'}</Button>} />
    {(message || error) && <div className={`workspace-alert ${error ? 'error' : ''}`}><Icon name={error ? 'close' : 'check'} /><span>{error || message}</span><button className="icon-button" onClick={() => { setMessage(''); setError(''); }}><Icon name="close" size={14} /></button></div>}
    <div className="metrics-row"><MetricCard icon="map-pin" label="Venues" value={venues.length} detail="managed locations" /><MetricCard icon="grid" label="Layout seats" value={totalSeats} detail="across all venues" /><MetricCard icon="layers" label="Categories" value={totalCategories} detail="pricing groups" /></div>
    {showCreate && <form className="creation-card" onSubmit={createVenue}><div className="creation-card-copy"><span className="creation-icon"><Icon name="map-pin" /></span><div><span className="section-kicker">New location</span><h2>Create a venue</h2><p>Start with the location details. Categories and rows come next.</p></div></div><div className="inline-form"><Field label="Venue name"><input required value={venueForm.name} onChange={(event) => setVenueForm({ ...venueForm, name: event.target.value })} placeholder="e.g. Horizon Arena" /></Field><Field label="Street address"><input required value={venueForm.address} onChange={(event) => setVenueForm({ ...venueForm, address: event.target.value })} placeholder="Full address" /></Field><Field label="City"><input required value={venueForm.city} onChange={(event) => setVenueForm({ ...venueForm, city: event.target.value })} placeholder="City" /></Field><Button disabled={busy === 'create'}>{busy === 'create' ? 'Creating...' : 'Create venue'}</Button></div></form>}
    {loading ? <div className="loading-panel"><LoadingState label="Loading venue operations" /></div> : <div className="admin-layout">
      <aside className="workspace-sidebar"><div className="sidebar-heading"><div><span className="section-kicker">Locations</span><h2>Venue directory</h2></div><span>{filtered.length}</span></div><label className="search-field compact"><Icon name="search" /><input aria-label="Search venues" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search venues" /></label><div className="venue-list">{filtered.map((venue) => <button className={selected?.id === venue.id ? 'venue-list-item active' : 'venue-list-item'} key={venue.id} onClick={() => void loadVenue(venue.id)}><span className="venue-list-icon"><Icon name="map-pin" /></span><span><strong>{venue.name}</strong><small>{venue.city} / {venue._count?.seats ?? 0} seats</small></span><Icon name="arrow-right" size={15} /></button>)}</div>{!filtered.length && <p className="sidebar-empty">No venue matches that search.</p>}</aside>
      <div className="workspace-main">{selected ? <VenueDetail venue={selected} editForm={editForm} setEditForm={setEditForm} categoryForm={categoryForm} setCategoryForm={setCategoryForm} seatForm={seatForm} setSeatForm={setSeatForm} busy={busy} onUpdate={updateVenue} onCategory={addCategory} onSeats={addSeatRow} /> : <EmptyState icon="map-pin" title="Select a venue" copy="Choose a location to edit its details, categories, and live seat-layout preview." />}</div>
    </div>}
  </section>;
}

function VenueDetail({ venue, editForm, setEditForm, categoryForm, setCategoryForm, seatForm, setSeatForm, busy, onUpdate, onCategory, onSeats }: { venue: Venue; editForm: { name: string; address: string; city: string }; setEditForm: (value: typeof editForm) => void; categoryForm: { name: string; color: string }; setCategoryForm: (value: typeof categoryForm) => void; seatForm: { rowLabel: string; count: number; categoryId: string }; setSeatForm: (value: typeof seatForm) => void; busy: string; onUpdate: (event: FormEvent) => void; onCategory: (event: FormEvent) => void; onSeats: (event: FormEvent) => void }) {
  const rows = [...new Set((venue.seats ?? []).map((seat) => seat.rowLabel))];
  return <>
    <div className="venue-hero"><div><span className="section-kicker">Selected venue</span><h2>{venue.name}</h2><p><Icon name="map-pin" />{venue.address}, {venue.city}</p></div><div className="venue-hero-stats"><span><strong>{venue.seats?.length ?? 0}</strong><small>seats</small></span><span><strong>{venue.categories.length}</strong><small>categories</small></span></div></div>
    <div className="seat-preview-card"><div className="card-heading"><div><span className="section-kicker">Layout preview</span><h3>Seat map</h3></div><div className="category-dots">{venue.categories.map((category) => <span key={category.id}><i style={{ background: category.color }} />{category.name}</span>)}</div></div><div className="mini-screen">STAGE / SCREEN</div><div className="mini-map">{rows.length ? rows.map((row) => <div key={row}><b>{row}</b><span>{(venue.seats ?? []).filter((seat) => seat.rowLabel === row).map((seat) => <i key={seat.id} title={`${row}${seat.seatNumber}`} style={{ background: seat.category?.color ?? '#FC4C01' }} />)}</span></div>) : <p>No rows added yet.</p>}</div></div>
    <div className="configuration-grid">
      <form className="config-card" onSubmit={onUpdate}><div className="card-heading"><div><span className="step-number">01</span><h3>Venue details</h3></div><Icon name="map-pin" /></div><Field label="Name"><input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></Field><Field label="Address"><input required value={editForm.address} onChange={(event) => setEditForm({ ...editForm, address: event.target.value })} /></Field><Field label="City"><input required value={editForm.city} onChange={(event) => setEditForm({ ...editForm, city: event.target.value })} /></Field><Button variant="secondary" disabled={busy === 'edit'}>{busy === 'edit' ? 'Saving...' : 'Save details'}</Button></form>
      <form className="config-card" onSubmit={onCategory}><div className="card-heading"><div><span className="step-number">02</span><h3>Seat categories</h3></div><Icon name="layers" /></div><Field label="Category name"><input required value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} placeholder="Premium, Standard..." /></Field><Field label="Category colour"><div className="color-input"><input type="color" value={categoryForm.color} onChange={(event) => setCategoryForm({ ...categoryForm, color: event.target.value })} /><code>{categoryForm.color}</code></div></Field><div className="category-chips">{venue.categories.map((category) => <span key={category.id}><i style={{ background: category.color }} />{category.name}</span>)}</div><Button variant="secondary" disabled={busy === 'category'}>{busy === 'category' ? 'Adding...' : 'Add category'}</Button></form>
      <form className="config-card" onSubmit={onSeats}><div className="card-heading"><div><span className="step-number">03</span><h3>Add a seat row</h3></div><Icon name="grid" /></div><div className="two-field"><Field label="Row label"><input required maxLength={8} value={seatForm.rowLabel} onChange={(event) => setSeatForm({ ...seatForm, rowLabel: event.target.value })} /></Field><Field label="Seat count"><input required min={1} max={50} type="number" value={seatForm.count} onChange={(event) => setSeatForm({ ...seatForm, count: Number(event.target.value) })} /></Field></div><Field label="Seat category"><select required value={seatForm.categoryId} onChange={(event) => setSeatForm({ ...seatForm, categoryId: event.target.value })}><option value="">Choose a category</option>{venue.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field><p className="form-hint"><Icon name="plus" size={13} />Adds seats after the last number if this row already exists.</p><Button variant="secondary" disabled={!venue.categories.length || busy === 'seats'}>{busy === 'seats' ? 'Adding row...' : `Add ${seatForm.count} seats`}</Button></form>
    </div>
  </>;
}

function OrganiserWorkspace() {
  const initialStart = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const emptyForm = () => ({ venueId: '', title: '', description: '', type: 'CONCERT' as 'CONCERT' | 'MOVIE', startsAt: toLocalInput(initialStart), endsAt: toLocalInput(new Date(initialStart.getTime() + 2 * 60 * 60_000)) });
  const [venues, setVenues] = useState<Venue[]>([]);
  const [events, setEvents] = useState<OrganiserEvent[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [reportEvent, setReportEvent] = useState<OrganiserEvent | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState('');
  const venue = useMemo(() => venues.find((item) => item.id === form.venueId), [venues, form.venueId]);

  const load = async () => {
    const [venueResponse, eventResponse] = await Promise.all([api<{ venues: Venue[] }>('/organiser/venues'), api<{ events: OrganiserEvent[] }>('/organiser/events')]);
    setVenues(venueResponse.venues); setEvents(eventResponse.events);
    if (!form.venueId && venueResponse.venues[0]) setForm((current) => ({ ...current, venueId: venueResponse.venues[0].id }));
  };
  useEffect(() => { void load().catch((caught) => setError(toMessage(caught))).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (venue) setPrices((current) => Object.fromEntries(venue.categories.map((category) => [category.id, current[category.id] ?? '']))); }, [venue?.id]);

  const resetForm = () => {
    const next = emptyForm();
    next.venueId = venues[0]?.id ?? '';
    setForm(next); setPrices({}); setEditingId(''); setShowForm(false);
  };
  const submitEvent = async (event: FormEvent) => {
    event.preventDefault(); if (!venue) return; setBusy('event'); setError('');
    const payload = { ...form, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), prices: venue.categories.map((category) => ({ categoryId: category.id, price: Number(prices[category.id]) })) };
    try {
      await api(editingId ? `/organiser/events/${editingId}` : '/organiser/events', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      await load(); setMessage(editingId ? 'Draft event updated.' : 'Draft event created. Review it before publishing.'); resetForm();
    } catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const editEvent = (item: OrganiserEvent) => {
    const venueId = item.venueId ?? venues.find((candidate) => candidate.name === item.venue.name)?.id ?? '';
    setForm({ venueId, title: item.title, description: item.description ?? '', type: item.type, startsAt: toLocalInput(new Date(item.startsAt)), endsAt: toLocalInput(new Date(item.endsAt)) });
    setPrices(Object.fromEntries(item.categoryPrices.map((price) => [price.categoryId ?? price.category.id, String(price.price)])));
    setEditingId(item.id); setShowForm(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const publish = async (id: string) => {
    setBusy(`publish-${id}`); setError('');
    try { await api(`/organiser/events/${id}/publish`, { method: 'POST', body: '{}' }); await load(); setMessage('Event published. Its live seat inventory is ready.'); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };
  const viewReport = async (item: OrganiserEvent) => {
    setBusy(`report-${item.id}`); setError('');
    try { setReport((await api<{ report: Report }>(`/organiser/events/${item.id}/report`)).report); setReportEvent(item); }
    catch (caught) { setError(toMessage(caught)); }
    finally { setBusy(''); }
  };

  const published = events.filter((event) => event.status === 'PUBLISHED');
  const drafts = events.filter((event) => event.status === 'DRAFT');
  const nearest = [...published].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];

  return <section className="workspace-page page-width">
    <WorkspaceHeader kicker="Organiser studio" title="Event operations" copy="Build listings, publish per-show inventory, and watch performance from one focused workspace." action={<Button icon={showForm ? 'close' : 'plus'} onClick={() => { if (showForm) resetForm(); else setShowForm(true); }}>{showForm ? 'Close editor' : 'Create event'}</Button>} />
    {(message || error) && <div className={`workspace-alert ${error ? 'error' : ''}`}><Icon name={error ? 'close' : 'check'} /><span>{error || message}</span><button className="icon-button" onClick={() => { setMessage(''); setError(''); }}><Icon name="close" size={14} /></button></div>}
    <div className="metrics-row"><MetricCard icon="calendar" label="Published" value={published.length} detail="live event listings" /><MetricCard icon="layers" label="Drafts" value={drafts.length} detail="awaiting review" /><MetricCard icon="clock" label="Next show" value={nearest ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(nearest.startsAt)) : '--'} detail={nearest?.title ?? 'nothing scheduled'} /></div>
    {showForm && <EventEditor form={form} setForm={setForm} venues={venues} venue={venue} prices={prices} setPrices={setPrices} editing={Boolean(editingId)} busy={busy} onSubmit={submitEvent} onCancel={resetForm} />}
    {loading ? <div className="loading-panel"><LoadingState label="Loading event operations" /></div> : <div className="organiser-layout"><div className="events-panel"><div className="panel-title"><div><span className="section-kicker">Portfolio</span><h2>Your events</h2></div><span>{events.length} total</span></div>{events.length ? <div className="event-records">{events.map((item) => <article className="event-record" key={item.id}><div className={`record-art ${item.type.toLowerCase()}`}><Icon name={item.type === 'CONCERT' ? 'music' : 'film'} size={24} /><span>{new Intl.DateTimeFormat('en-IN', { day: '2-digit' }).format(new Date(item.startsAt))}</span><small>{new Intl.DateTimeFormat('en-IN', { month: 'short' }).format(new Date(item.startsAt))}</small></div><div className="record-copy"><div><StatusBadge status={item.status} /><small>{item.type}</small></div><h3>{item.title}</h3><p><Icon name="map-pin" size={14} />{item.venue.name}<span /><Icon name="calendar" size={14} />{formatDate(item.startsAt)}</p><div className="record-prices">{item.categoryPrices.map((price) => <span key={price.category.id}><i style={{ background: price.category.color }} />{price.category.name} {money(price.price)}</span>)}</div></div><div className="record-actions">{item.status === 'DRAFT' && <Button variant="secondary" size="sm" icon="grid" onClick={() => editEvent(item)}>Edit draft</Button>}{item.status === 'DRAFT' && <Button size="sm" icon="arrow-right" disabled={busy === `publish-${item.id}`} onClick={() => void publish(item.id)}>{busy === `publish-${item.id}` ? 'Publishing...' : 'Publish'}</Button>}<Button variant="quiet" size="sm" icon="wallet" disabled={busy === `report-${item.id}`} onClick={() => void viewReport(item)}>Report</Button></div></article>)}</div> : <EmptyState icon="calendar" title="No events yet" copy="Create your first movie or concert listing to begin." action={<Button icon="plus" onClick={() => setShowForm(true)}>Create event</Button>} />}</div><ReportPanel report={report} event={reportEvent} /></div>}
  </section>;
}

function EventEditor({ form, setForm, venues, venue, prices, setPrices, editing, busy, onSubmit, onCancel }: { form: { venueId: string; title: string; description: string; type: 'CONCERT' | 'MOVIE'; startsAt: string; endsAt: string }; setForm: (value: typeof form) => void; venues: Venue[]; venue?: Venue; prices: Record<string, string>; setPrices: (value: Record<string, string>) => void; editing: boolean; busy: string; onSubmit: (event: FormEvent) => void; onCancel: () => void }) {
  return <form className="event-editor" onSubmit={onSubmit}><div className="editor-heading"><span className="creation-icon"><Icon name={editing ? 'grid' : 'plus'} /></span><div><span className="section-kicker">{editing ? 'Draft editor' : 'New listing'}</span><h2>{editing ? 'Refine your event' : 'Create an event'}</h2><p>Set the experience, schedule, venue, and category-level ticket prices.</p></div></div><div className="editor-grid"><div className="editor-section"><span className="step-number">01</span><h3>Event details</h3><Field label="Title"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Event or movie title" /></Field><Field label="Description"><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What should guests expect?" /></Field><Field label="Event type"><div className="type-picker"><button type="button" className={form.type === 'CONCERT' ? 'active' : ''} onClick={() => setForm({ ...form, type: 'CONCERT' })}><Icon name="music" />Concert</button><button type="button" className={form.type === 'MOVIE' ? 'active' : ''} onClick={() => setForm({ ...form, type: 'MOVIE' })}><Icon name="film" />Movie</button></div></Field></div><div className="editor-section"><span className="step-number">02</span><h3>Where & when</h3><Field label="Venue"><select required value={form.venueId} onChange={(event) => setForm({ ...form, venueId: event.target.value })}><option value="">Select a configured venue</option>{venues.map((item) => <option key={item.id} value={item.id}>{item.name}, {item.city}</option>)}</select></Field><Field label="Starts"><input required type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></Field><Field label="Ends"><input required type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></Field></div><div className="editor-section pricing-section"><span className="step-number">03</span><h3>Category pricing</h3>{venue?.categories.length ? <div className="price-fields">{venue.categories.map((category) => <Field key={category.id} label={category.name}><div className="price-input"><span>INR</span><input required min={1} type="number" value={prices[category.id] ?? ''} onChange={(event) => setPrices({ ...prices, [category.id]: event.target.value })} placeholder="0" /><i style={{ background: category.color }} /></div></Field>)}</div> : <p className="form-hint">Select a venue with configured categories to set prices.</p>}<p className="form-hint"><Icon name="shield" size={13} />Prices are copied into each show seat when you publish.</p></div></div><div className="editor-actions"><Button variant="quiet" type="button" onClick={onCancel}>Cancel</Button><Button icon="check" disabled={!venue?.categories.length || busy === 'event'}>{busy === 'event' ? 'Saving...' : editing ? 'Save draft changes' : 'Create draft event'}</Button></div></form>;
}

function ReportPanel({ report, event }: { report: Report | null; event: OrganiserEvent | null }) {
  if (!report || !event) return <aside className="report-panel empty-report"><span className="report-visual"><Icon name="wallet" size={27} /></span><span className="section-kicker">Performance</span><h2>Select an event report</h2><p>Revenue, occupancy, confirmed bookings, and category performance will appear here.</p></aside>;
  return <aside className="report-panel"><div className="report-heading"><div><span className="section-kicker">Live report</span><h2>{event.title}</h2></div><StatusBadge status={event.status} /></div><div className="report-revenue"><small>Confirmed revenue</small><strong>{money(report.revenue)}</strong><span>{report.confirmedBookings} booking{report.confirmedBookings === 1 ? '' : 's'}</span></div><div className="occupancy"><div><span>Seat occupancy</span><strong>{report.occupancyPercent}%</strong></div><div className="progress-track"><i style={{ width: `${Math.min(100, report.occupancyPercent)}%` }} /></div><small>{report.seatsSold} of {report.totalSeats} seats sold</small></div><div className="category-report"><span className="section-kicker">By category</span>{Object.entries(report.revenueByCategory).length ? Object.entries(report.revenueByCategory).map(([name, data]) => <div key={name}><span><strong>{name}</strong><small>{data.seatsSold} seats</small></span><strong>{money(data.revenue)}</strong></div>) : <p>No confirmed sales yet.</p>}</div></aside>;
}

function WorkspaceHeader({ kicker, title, copy, action }: { kicker: string; title: string; copy: string; action: ReactNode }) {
  return <div className="workspace-header"><div><span className="section-kicker">{kicker}</span><h1>{title}</h1><p>{copy}</p></div>{action}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function toLocalInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong.'; }

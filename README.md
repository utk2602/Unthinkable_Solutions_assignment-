# Ticketly — Ticket Booking System

Ticketly is a full-stack movie and concert booking platform built for the Unthinkable Solutions assignment. It protects high-demand inventory with transactional seat holds, releases abandoned checkout sessions automatically, and offers cancelled seats to a category-based waitlist.

## Included features

- Role-based JWT authentication for customers, organisers, and admins
- Admin venue, category, and seat-layout APIs
- Organiser event creation, per-category pricing, publishing, and revenue reporting
- A per-show seat snapshot and live visual seat map
- PostgreSQL row locks and serializable transactions for safe seat holds and checkout
- Configurable seat-hold expiry, automatic release, and Socket.IO seat-map refreshes
- Booking history, cancellation, QR-code ticket generation, and idempotent checkout
- FIFO waitlists by event and seat category, expiring offers, and automatic re-offers
- SMTP email queue for QR tickets, cancellation confirmations, and waitlist links
- React frontend for customer booking/waitlist flows and admin/organiser workspaces

## Stack

| Area | Technology |
| --- | --- |
| Database | PostgreSQL (local, Supabase, Neon, or another hosted provider) |
| Backend | Node.js, TypeScript, Fastify, Prisma |
| Auth | JWT, bcrypt |
| Realtime | Socket.IO |
| QR / email | `qrcode`, Nodemailer SMTP |
| Frontend | React, Vite, TypeScript |

## Local setup

Prerequisites: Node.js 22+, PostgreSQL 14+, and an SMTP account. Gmail SMTP works with a Google app password.

1. Create a PostgreSQL database, copy `backend/.env.example` to `backend/.env`, and set its connection string. `DATABASE_URL` is sufficient for a local database; `DIRECT_URL` may use the same value. Do not commit this file. URL-encode special password characters; for example, `#` becomes `%23`.
2. Copy `frontend/.env.example` to `frontend/.env` if the backend is not running at `http://localhost:4000/api/v1`.
3. Install dependencies and generate the client:

```powershell
Set-Location backend
npm install
npm run prisma:generate
npm run prisma:deploy
npm run prisma:seed
npm run dev
```

In a second terminal:

```powershell
Set-Location frontend
npm install
npm run dev
```

Open `http://localhost:5173`; interactive API documentation is at `http://localhost:4000/docs`.

The seed command creates these accounts, all using password `DemoPass123!`:

| Role | Email |
| --- | --- |
| Admin | `admin@ticketly.test` |
| Organiser | `organiser@ticketly.test` |
| Customer | `customer@ticketly.test` |

## Environment variables

`DATABASE_URL` is used by the runtime and `DIRECT_URL` is used by Prisma migrations. They may be identical for local PostgreSQL. On providers with connection pooling, use the pooled runtime URL for `DATABASE_URL` and the direct URL for `DIRECT_URL`. The frontend only needs `VITE_API_URL` when the API is not at `http://localhost:4000/api/v1`.

For Gmail, use `smtp.gmail.com`, port `587`, your full Gmail address as `SMTP_USER`, and a Google app password as `SMTP_PASS`. Configure all `SMTP_*` values for delivery. Failed messages are retained and retried up to three times rather than silently discarded.

## Core API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | Create customer or organiser account |
| POST | `/api/v1/auth/login` | Obtain JWT |
| POST | `/api/v1/admin/venues` | Create venue (admin) |
| PATCH | `/api/v1/admin/venues/:id` | Update venue details (admin) |
| POST | `/api/v1/admin/venues/:id/categories` | Add category (admin) |
| POST | `/api/v1/admin/venues/:id/seats` | Add seat grid (admin) |
| GET | `/api/v1/organiser/venues` | List venues available to organisers |
| POST | `/api/v1/organiser/events` | Create draft event |
| PATCH | `/api/v1/organiser/events/:id` | Update a draft event |
| POST | `/api/v1/organiser/events/:id/publish` | Snapshot and publish event |
| GET | `/api/v1/events` | Browse published events |
| GET | `/api/v1/events/:id/seats` | Read live seat map |
| POST | `/api/v1/events/:id/holds` | Hold selected seats |
| POST | `/api/v1/holds/:id/checkout` | Confirm booking; provide `Idempotency-Key` |
| POST | `/api/v1/bookings/:id/cancel` | Cancel and offer released seats |
| POST | `/api/v1/events/:id/waitlist` | Join category waitlist |
| GET | `/api/v1/waitlist` | View the customer's queue entries and offers |
| DELETE | `/api/v1/waitlist/:id` | Leave a waitlist and release an active offer |
| GET | `/api/v1/waitlist/offers/:token` | View an authenticated offer link |
| POST | `/api/v1/waitlist/offers/:token/accept` | Accept waitlist offer |
| GET | `/api/v1/organiser/events/:id/report` | Event revenue report |

## Seat holds, waitlists, and safety

Seat status is stored per event in `ShowSeat`; the venue’s master layout is never altered when a show is booked. A hold opens a serializable transaction, locks selected `ShowSeat` rows with `SELECT … FOR UPDATE` in sorted order, releases any relevant expired holds, then atomically creates a hold and marks seats `HELD`. A second simultaneous request encounters the lock and then sees a non-available status, so it fails. Checkout locks the same rows, validates hold ownership and expiry, and atomically creates the booking and marks seats `BOOKED`.

The background worker runs every 30 seconds. It expires holds, releases their seats, expires unaccepted waitlist offers, and creates an offer for the next FIFO entry in the same event/category. Seat-map clients join an event-specific Socket.IO room and refetch their map after a change. See [system design](docs/system-design.md) for the complete flow.

## Checks

```powershell
Set-Location backend
npm run build
npm test

Set-Location ..\frontend
npm run build
```

With both applications running, the repeatable integration checks are:

```powershell
Set-Location backend
npm run test:e2e

Set-Location ..\frontend
npm run test:realtime
```

The E2E check creates isolated records, verifies RBAC, validation, admin/organiser setup, concurrent holds (`201` plus `409`), TTL release, idempotent checkout, QR generation, cancellation, FIFO waitlist expiry/re-offering, acceptance, and reporting, then removes its fixtures. `npm run test:smtp` sends one QR smoke email to the configured `SMTP_USER` mailbox.

## Deployment

- Deploy `backend` to Railway or Render, add all backend environment variables, run `npm run prisma:deploy`, and use `npm run build` then `npm start`.
- Deploy `frontend` to Vercel with `VITE_API_URL` pointing to the hosted backend’s `/api/v1` URL.
- Update `FRONTEND_ORIGIN` in the backend to the Vercel URL.
- Run Prisma migrations against the production PostgreSQL database before accepting traffic.

# System design write-up

Ticketly uses PostgreSQL as its system of record and works with either a local database or a hosted PostgreSQL provider. The important inventory table is `ShowSeat`, not the venue’s static `VenueSeat` table. When an organiser publishes an event, the active venue seats are copied into `ShowSeat` together with the price for that event. This means a venue layout or price change cannot mutate an already published show or historic booking.

## Seat hold and TTL mechanism

A customer creates a hold by submitting the event ID and chosen `ShowSeat` IDs. The API starts a PostgreSQL serializable transaction and locks those seat rows using `SELECT FOR UPDATE`. IDs are ordered before locking, which gives concurrent requests a consistent lock order and reduces deadlock risk. The transaction releases expired relevant holds, confirms every selected seat belongs to the event and is `AVAILABLE`, then creates a `Hold` and its `HoldSeat` rows. Finally, it changes the seats to `HELD` and commits. The expiration timestamp is calculated from `SEAT_HOLD_MINUTES`, defaulting to ten minutes.

An application worker runs every 30 seconds. It finds active holds whose expiry time has passed, marks their seats available, and changes the hold to `EXPIRED`. The seat-map read endpoint also performs an expiry pass before returning data, so availability remains correct if the worker is delayed. Releasing a hold manually uses the same row-locking discipline.

## Concurrency prevention

The frontend map is only a convenience layer; it never authorizes a booking. The database transaction is the authority. If two customers choose the same seat, the first request locks the row. The second waits, then observes `HELD` after the first commits and receives a conflict response. Checkout locks the same rows, verifies that the hold belongs to the caller and has not expired, then changes the seats to `BOOKED` and creates a booking in one transaction. An optional `Idempotency-Key` ensures retries cannot create two bookings. PostgreSQL unique constraints additionally protect show-seat identity, booking references, and waitlist membership.

## Waitlist auto-assignment and time-limited offers

Waitlist entries are scoped to an event and seat category, sorted FIFO by creation time. When a confirmed booking is cancelled, its seats are locked and released within one transaction. For each released seat, the service claims the oldest `WAITING` entry for that category, creates a random non-guessable offer token, sets the seat to `HELD`, and sets an offer expiry from `WAITLIST_OFFER_MINUTES`. A notification is queued with a frontend link containing the token.

The receiving customer must be authenticated as the waitlist owner to accept the offer. Acceptance locks the offered seat, checks that the offer is active and unexpired, creates a confirmed QR-ticket booking, marks the seat booked, and marks the offer and entry accepted/fulfilled. The worker expires missed offers, marks the old entry expired so it cannot receive the same seat again, releases the seat, and advances to the next FIFO entry. This keeps offers fair and prevents unclaimed tickets from blocking inventory.

## Real-time and email delivery

Clients join an event-specific Socket.IO room. Seat changes from holds, releases, bookings, cancellations, and expiry flows emit a map-changed message; clients refetch the seat map from the backend rather than trusting a partial client update. Booking confirmation jobs generate a QR PNG from the booking reference payload and send it through configured SMTP. Email attempts are persisted as notifications with pending, sent, or failed status; failed deliveries retry at bounded intervals up to three attempts.

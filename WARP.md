# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project overview
Node/Express API for a parking-lot system backed by MySQL (via `mysql2/promise`). The API is organized as a small set of Express routers under `routes/`, with shared helpers in `utils/` and a single MySQL connection pool in `db.js`.

## Common commands
All commands assume you are at the repo root.

### Install
```sh
npm install
```

### Run (development)
Uses nodemon.
```sh
npm run dev
```

### Run (production-ish)
```sh
npm start
```

### Tests / lint
`package.json` currently has no configured test runner or linter:
- `npm test` exits with an error placeholder.
- There are no `lint` / `typecheck` scripts.

If you add tests later, prefer adding npm scripts so agents can run:
- `npm test` (all tests)
- `npm test -- <pattern>` or a dedicated `test:one` script (single test)

## Environment configuration
This API reads configuration from environment variables (loaded via `dotenv`). See `.env.example`:
- `DATABASE_URL` (MySQL connection URI)
- `JWT_SECRET`
- `PORT`

## High-level architecture

### HTTP entrypoint
- `server.js` is the main entrypoint:
  - creates the Express app
  - installs middleware (`cors`, JSON body parsing, `morgan`, `helmet`)
  - mounts feature routers
  - serves `/public` as static files from `public/` and also mounts `routes/public.js`

### Database access
- `db.js` exports `{ pool }` created with `mysql2/promise`.
- Most routes call `pool.query(...)` directly (raw SQL, no ORM).
- Some flows use transactions with `pool.getConnection()` + `beginTransaction()` (notably `routes/tickets.js` checkout and subscriber mutations).

### Authn/Authz
- JWT-based auth via `Authorization: Bearer <token>`.
- `utils/auth.js`:
  - `signUser(user)` signs a JWT with `{ id, role, email }` and an 8h expiry
  - `verifyPassword(plain, hash)` uses bcrypt
- `utils/requireAuth.js` exports `requireAuth(roles=[])` middleware:
  - verifies JWT using `process.env.JWT_SECRET`
  - populates `req.user`
  - optionally enforces role allowlist
  - note: there is also `requireAuth.optional`, but it currently references an undefined `SECRET` (likely a bug). If you plan to use `optional`, fix it to use `process.env.JWT_SECRET`.

### Business domains (routes)
Routers are mounted in `server.js` as:
- `/auth` → `routes/auth.js` (login + whoami)
- `/settings` → `routes/settings.js` (parking settings in `Settings` table)
- `/rateplans` → `routes/rateplans.js` (CRUD on `RatePlan`)
- `/tickets` → `routes/tickets.js`
  - ticket creation (including subscription-aware flow)
  - checkout flow with transaction + `Payment` insert
  - shift/summary endpoints query `v_ticket_summary` and related tables
- `/payments` → `routes/payments.js`
  - paginated listing with filters
  - CSV export endpoint
- `/reports` → `routes/reports.js` (occupancy and payment aggregates)
- `/subscribers` → `routes/subscribers.js`
  - subscriber CRUD
  - subscription billing actions update `Subscription` + insert `Payment`
- `/api/cash-shifts` → `routes/cashShift.js` (open/close cashier shifts)
- `/public` → static files + `routes/public.js`
  - public ticket summary endpoint intended for unauthenticated lookups

### Pricing calculation
- `utils/calcAmount.js` encapsulates pricing rules (tolerance window, night flat rate, per-hour vs per-15min).
- Used by `routes/tickets.js` (checkout) and `routes/public.js` (live ticket summary).

## Handy one-off scripts
- `hash.js` is a small helper to generate a bcrypt hash (prints to stdout). If you use it, update the input value inside the file before running:
```sh
node hash.js
```

## Where to look first when debugging
- Routing/HTTP wiring: `server.js`
- Auth issues (JWT/roles): `utils/requireAuth.js`, `utils/auth.js`, `routes/auth.js`
- Database connection issues: `db.js` and `.env` (for `DATABASE_URL`)
- Ticket checkout/payment correctness: `routes/tickets.js`, `routes/payments.js`, `utils/calcAmount.js`

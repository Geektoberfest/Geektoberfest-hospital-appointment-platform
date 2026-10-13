# Issue #11: Real-Time Waiting-List Reassignment Notifications (Server-Sent Events)

> File name note: sibling documentation uses `ISSUE_13_CHANGES.md` / `ISSUE_14_CHANGES.md`, while
> issue #15 uses `issue-15-changes.md`. This file keeps the name requested by the issue
> (`issue-11-changes.md`) and follows the same section structure and level of detail.

## 1. Issue Overview

**Issue #11 objective:** when a patient on an appointment waiting list is given a cancelled slot,
their browser must be told immediately — no page refresh, no polling.

**Approach (from the issue comments):** implement the notification service, wire it into
`assignFromWaitingList`, authenticate the stream with a short-lived single-use ticket (because
`EventSource` cannot send an `Authorization` header and the refresh cookie is scoped to
`/api/auth`), send a heartbeat every ~25 s so the hosting proxy does not drop idle connections, and
surface the notice in a frontend context that reconnects with a fresh ticket.

**Delivered:**

- `backend/services/notificationService.js`: an in-process registry of live SSE connections
  (`userId -> Set<client>`) exposing `notifyUser(userId, event, data)`, with per-connection
  heartbeats, dead-socket pruning, a per-user connection cap and full failure containment.
- `backend/utils/sseTickets.js`: 32-byte random tickets stored **only** as a SHA-256 hash, expiring
  after 30 seconds and consumed exactly once (atomically, on the single Node event loop).
- `POST /api/notifications/ticket` (patient, normal bearer auth) and
  `GET /api/notifications/stream?ticket=…` (`text/event-stream`, ticket-auth, 25 s heartbeat).
- `assignFromWaitingList` now emits `waitlist.assigned` with a minimal appointment payload **after**
  the appointment and the waiting-list entry are both persisted, in its own `try/catch`.
- `NotificationContext` + `useNotifications` + a banner in the authenticated layout: the stream opens
  only for a signed-in patient, reconnects with a fresh ticket and a bounded backoff, deduplicates by
  appointment, and is closed on logout/unmount.
- 43 new backend tests and 16 new frontend tests, including an end-to-end test where the real
  cancel endpoint pushes `waitlist.assigned` onto a patient's open stream.

## 2. Problem Addressed

| # | Gap before this change | Resolution |
|---|---|---|
| 1 | A reassigned slot was only visible after a manual refresh of "My appointments" / "Waiting list". | The backend pushes `waitlist.assigned` and the patient's open tab renders a banner within a second. |
| 2 | A patient could miss a reassignment entirely while reading a different page. | The provider lives above the router outlet, so the notice appears on every authenticated page. |
| 3 | There was no server→browser channel at all (no SSE, WebSocket, or Redis pub/sub in the codebase). | A minimal SSE channel — no new dependency, no new infrastructure. |
| 4 | `EventSource` cannot set headers, and putting the access token in a URL would leak a long-lived credential into access logs. | A 30-second, single-use, hashed-at-rest ticket that authorizes only one stream for one user. |
| 5 | Idle proxies (Render/nginx) silently drop long-lived HTTP responses. | Comment-frame heartbeats every 25 s plus `X-Accel-Buffering: no`. |
| 6 | Notifications must never be able to break the core allocation flow. | Delivery is attempted strictly after both writes, wrapped in `try/catch`, and `notifyUser` itself never throws. |

## 3. Implementation Overview

### Why Server-Sent Events

The data flow is one-directional (server → patient), and the project is a single Express process
served over plain HTTP. SSE therefore gives the required behaviour with:

- no new runtime dependency (no `socket.io`, no `ws`) — the browser's built-in `EventSource` is the
  client, and Express writes a plain chunked response;
- no handshake or upgrade to negotiate, so existing CORS (`origin` allowlist + `credentials`) and
  proxy configuration keep working unchanged;
- automatic, standards-based framing (`event:`/`data:`/`retry:`/comment lines).
  A WebSocket server would add a protocol upgrade path, a second auth mechanism and a lifecycle to
  manage for the same one-way use case. `ioredis` is installed, but `backend/config/redis.js`
  only ships `getCache`/`setCache`/`clearCache` — there is **no** pub/sub plumbing, so a
  cross-instance fan-out would mean new infrastructure rather than reusing verified infrastructure.

### End-to-end flow

```
 1. Patient signs in (existing bearer + HttpOnly refresh cookie flow, issue #15)
 2. NotificationProvider sees role === 'patient' and calls POST /api/notifications/ticket
      -> { ticket: <43-char base64url>, expiresIn: 30000 }   (stored only as sha256(ticket))
 3. It opens new EventSource(`${API_BASE}/notifications/stream?ticket=...`)
 4. GET /api/notifications/stream consumes the ticket atomically, re-checks the session,
    writes the SSE headers, sends `retry: 30000` + `: connected`, registers the connection
    and starts a 25 s heartbeat
 5. A doctor/patient/admin cancels an appointment
      -> Appointment.status = 'cancelled' (persisted, existing behaviour)
      -> assignFromWaitingList() finds the oldest eligible waiting entry
      -> Appointment.create(...)  +  entry.status = 'assigned' (both persisted)
      -> notifyUser(entry.patient, 'waitlist.assigned', {...appointment facts})
 6. Every live stream of that patient receives the frame; other patients receive nothing
 7. On close/error the route removes the connection and clears its heartbeat timer
 8. If the stream drops, the frontend closes it and re-opens it with a *new* ticket
    (delays 1 s, 2 s, 5 s, 10 s, 20 s, 30 s — then 30 s)
```

## 4. Files Changed

### Backend — new

| File | Purpose |
|---|---|
| `backend/services/notificationService.js` | Live-connection registry per user, `notifyUser`, SSE frame formatting, heartbeat timers, capacity limits, disconnect pruning. Never throws. |
| `backend/utils/sseTickets.js` | Ticket generation (`crypto.randomBytes(32)`), SHA-256-at-rest storage, TTL/expiry sweep, bounded store and the atomic `consumeTicket`. |
| `backend/controllers/notificationController.js` | `createTicket` (authenticated) and `openStream` (ticket-auth, SSE headers, heartbeat bootstrap, cleanup wiring). |
| `backend/routes/notificationRoutes.js` | `POST /ticket` behind `protect` + `authorize('patient')`; `GET /stream` deliberately *not* behind `protect`. |
| `backend/tests/notificationService.test.js` | 23 tests: delivery/isolation, disconnect pruning, write failures, heartbeats, capacity, ticket crypto/expiry/single-use/concurrency/bounds. |
| `backend/tests/waitlistNotification.test.js` | 9 tests: the reassignment → notification seam, payload minimality, ordering, no notification on failure or retry. |
| `backend/tests/notificationApi.test.js` | 11 HTTP-level tests over the real Express app: ticket auth/roles, stream headers/heartbeat, single-use, concurrency, cross-user isolation, cleanup, and the full cancel → reassign → stream flow. |

### Backend — modified

| File | Change |
|---|---|
| `backend/controllers/waitingListController.js` | Adds `lookupDoctorName` + `buildAssignmentPayload` and emits `waitlist.assigned` after both writes; exports `WAITLIST_ASSIGNED_EVENT`. Existing selection/creation logic is unchanged. |
| `backend/server.js` | Mounts `app.use('/api/notifications', require('./routes/notificationRoutes'))` after the existing route mounts, before `notFound`. |
| `backend/.env.example` | Documents `SSE_TICKET_TTL_MS`, `SSE_MAX_TICKETS`, `SSE_HEARTBEAT_MS`. |

### Frontend — new

| File | Purpose |
|---|---|
| `frontend/src/api/notificationStream.js` | React/axios-free core: `nextBackoffMs`, `streamUrl`, defensive `parseAssignment`, `mergeNotification` and the `createNotificationStream` lifecycle manager (injectable timers/EventSource). |
| `frontend/src/api/notificationApi.js` | `requestTicket()` (authenticated POST through the shared axios instance) and `buildStreamUrl(ticket)`. |
| `frontend/src/context/NotificationContext.jsx` | Opens the stream for signed-in patients only, exposes `{ notifications, status, connected, dismiss, clear }`. |
| `frontend/src/hooks/useNotifications.js` | Context accessor mirroring `useAuth`. |
| `frontend/src/components/common/NotificationBanner.jsx` | Accessible (`role="status"`, `aria-live="polite"`) notice with date/time, "View appointment" link and dismiss/dismiss-all. |
| `frontend/tests/notificationStream.test.js` | 16 tests: backoff bounds, URL encoding, payload parsing, dedupe/bounds, and the full connect/reconnect/stop lifecycle with a fake `EventSource`. |

### Frontend — modified

| File | Change |
|---|---|
| `frontend/src/main.jsx` | Wraps the app in `<NotificationProvider>` inside `AuthProvider` (one provider, no double wrapping). |
| `frontend/src/components/common/Layout.jsx` | Renders `<NotificationBanner />` at the top of the authenticated `<main>` area. |

### Repository root

| File | Change |
|---|---|
| `issue-11-changes.md` | This document. |
| `README.md` | Two rows added to the documented API table and one sentence pointing at this file. This is a documentation-consistency change only: the endpoint table is the project's documented API contract, and the new env vars must be discoverable from the deployment section. No feature or architecture claims were rewritten. |

## 5. Notification Service

`backend/services/notificationService.js` keeps `connections: Map<userId, Set<client>>`, where a
client holds only `{ id, userId, res, createdAt, heartbeatTimer }` — no token, ticket or personal
data.

- **`notifyUser(userId, event, data)`** serializes one frame per connection
  (`event: <name>\ndata: <json>\n\n`) and returns how many connections received it (`0` when the
  patient is offline — the normal case). The whole body is wrapped in `try/catch`; it cannot throw,
  so a delivery problem can never propagate into the cancellation flow.
- **Multiple tabs** are supported by construction: every connection of the user is served, and the
  `Set` is copied before iteration so a failed write cannot corrupt the loop.
- **Disconnect handling:** `removeClient` clears the heartbeat interval and drops the client from the
  registry. It is idempotent and is called from the route's `close`/`error` handlers *and* from a
  failed write, so a socket that dies without a clean `close` is still released.
- **Failure containment:** every write goes through `isWritable()` (`writableEnded`, `destroyed`,
  `finished`) plus `try/catch`. A write that throws is treated exactly like a disconnect: the client
  is removed and `false` is returned. Tests cover a destroyed response and a `write()` that throws
  `EPIPE`; neither crashes the caller and only the broken connection is dropped.
- **Bounded resources:** at most `MAX_CONNECTIONS_PER_USER` (10) streams per patient — one more
  evicts the oldest (the newest tab always wins) — and at most `MAX_TOTAL_CONNECTIONS` (5000)
  overall, above which `openStream` answers `503` before writing any headers.
- Identifiers are normalized (`ObjectId`, string or numeric) so a patient registered by object id and
  addressed by hex string resolve to the same bucket.
- Heartbeats are plain SSE comments (`: ping`), never fake events, and their `Timeout` is `unref()`ed
  so an idle stream never keeps the process alive.

## 6. Waiting-List Integration

Inside `assignFromWaitingList`, the notification is emitted at exactly one place: **after**
`Appointment.create(...)` succeeded **and** `entry.status = 'assigned'` / `entry.appointment` were
saved. The existing selection logic (oldest waiting entry, `preferredTime` match, skipping patients
who already hold a slot, `11000` duplicate-key fallback) is untouched, and no database operation was
reordered — the notification is added at the end of the successful branch, which returns immediately.

Reliability rules and how they are met:

| Requirement | How |
|---|---|
| A notification failure must not invalidate a persisted reassignment | `notifyUser` never throws; the call is additionally wrapped in `try/catch` (a payload-lookup failure is caught and logged). Tested: an injected thrower still returns the created appointment and leaves the entry `assigned`. |
| Cancellation/waiting list must keep working while the patient is offline | `notifyUser` returns `0` and nothing else happens. Tested with the real registry and zero connections. |
| No notification before the appointment exists | The call sits after both `await`s; a test asserts the call order `appointment.create → entry.save → notify`. |
| No duplicate notifications from retries | The event is emitted once per successful assignment (the loop returns immediately), and a retry finds no `waiting` candidate (the real query filter) — tested by running the assignment twice against a stateful find stub: exactly one event. |
| Nothing is announced for a failed assignment | `11000` duplicates `continue` to the next candidate; if none succeeds, `null` is returned and no event is emitted. A second test proves only the patient who actually got the slot is notified. |
| Minimal, appropriate payload | `appointmentId`, `waitingListEntryId`, `date`, `startTime`, `endTime`, `doctorName`, `specialization`, `status`. A test asserts the serialized payload contains none of `reason`, `notes`, `email`, `password`, `token`, `sessionId`. |

The doctor display name is resolved by a deliberately best-effort helper (`lookupDoctorName`): it
reuses the already-populated doctor document when available and otherwise performs one
`Doctor.findById(...).populate('user', 'name')`, returning `''` if that lookup fails. A cosmetic
lookup can therefore never turn a successful reassignment into an error.

## 7. Ticket Authentication

**Why a ticket:** `EventSource` cannot send `Authorization`, and the refresh cookie is scoped to
`/api/auth`. Tempting alternatives were rejected: an access token in the query string would place a
long-lived credential in URLs (and therefore in infrastructure access logs), and a long-lived
stream-scoped cookie would weaken the existing token model.

| Property | Implementation |
|---|---|
| Issuance | `POST /api/notifications/ticket` behind the existing `protect` **and** `authorize('patient')`. |
| Identity source | `req.user._id` and `req.sessionId` from the verified access token + live session lookup. A client-supplied user id is never read (there is no such parameter). |
| Randomness | `crypto.randomBytes(32).toString('base64url')` → 43 URL-safe characters. |
| Storage | Only `sha256(ticket)` is kept, mapped to `{ userId, sessionId, expiresAt }`; the raw value exists only in the response body. A test proves the stored hash cannot be presented as a ticket. |
| Expiry | `SSE_TICKET_TTL_MS`, default 30 000 ms. Expired entries are dropped on the next issuance (`sweepExpired`). |
| Single use | `consumeTicket` deletes the entry and then checks expiry, in one synchronous block. On Node's single event loop no concurrent request can observe the same entry, so one caller wins and every other caller gets `null`. Tested at the unit level (8 racing consumers → 1 winner) and over HTTP (two simultaneous stream requests → exactly one `200`). |
| Scope | The ticket authorizes opening exactly one stream for its own user. Tests prove a ticket for patient A never receives patient B's events, and that the stream endpoint rejects missing, empty, malformed, over-long, repeated and unknown `ticket` parameters with `401` **without touching the store**. |
| Not a general credential | It is never accepted by any other endpoint (no middleware consumes it), and the response contains no user id, session id or token. |
| Session re-check at open | After consuming the ticket, `RefreshToken.exists({ sessionId, user, revokedAt: null, expiresAt: { $gt: now } })` must still match, so a revoked/expired session cannot open (or hold open) a stream. Tested: a valid ticket with a revoked session → `401`. |
| Secret hygiene | The raw ticket is never logged, never included in an error message, and never stored in a URL by the application: `utils/audit.js` strips query strings from every audit record as a defence in depth. |

Storage is the in-process `Map` in `backend/utils/sseTickets.js` (bounded by `SSE_MAX_TICKETS`,
default 5000, oldest dropped first) — the right fit for the verified single-instance deployment. A
multi-instance deployment would need a shared atomic store (e.g. Redis `GETDEL`/Lua) — see
section 14.

## 8. SSE Stream Lifecycle

`GET /api/notifications/stream?ticket=…`:

1. **Consume** the ticket (rejecting anything invalid with a JSON `401`); **re-check** the session;
   **reject** with `503` when the connection cap is reached — all *before* any header is written, so
   failures are ordinary JSON responses rather than half-open streams.
2. **Headers:** `Content-Type: text/event-stream; charset=utf-8`,
   `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
   `X-Accel-Buffering: no` (disables nginx/Render response buffering), then `res.flushHeaders()` so
   the browser is told the stream is open immediately. The socket idle timeout is disabled for the
   stream (`req.socket.setTimeout(0)`).
3. **Bootstrap:** `retry: 30000` (a browser that reconnects on its own must not replay a spent ticket
   within a couple of seconds) followed by the comment `: connected`.
4. **Register** the connection and start its heartbeat: `: ping` every `SSE_HEARTBEAT_MS`
   (default 25 000 ms). Heartbeats are comment frames, so they never surface as notifications.
5. **Cleanup:** `req.on('close')`, `res.on('close')` and `res.on('error')` all route to the same
   idempotent `removeClient`, which clears the heartbeat interval and unregisters the connection;
   a failed write inside the service does the same. Verified over HTTP: after a client abort,
   `userConnectionCount` returns to `0`, and after three concurrent streams all three are released.

**Reconnection (frontend):** `EventSource`'s built-in reconnect is unusable here because it replays
the same, already-consumed ticket. `createNotificationStream` therefore closes the source on every
`error` and reconnects after a bounded, non-decreasing delay
(`[1000, 2000, 5000, 10000, 20000, 30000]` ms, ceiling 30 s). A successful `open` resets the schedule,
so a flapping network cannot escalate to 30 s permanently and an unreachable backend cannot cause a
tight retry loop.

## 9. Frontend Integration

- **Provider:** `<NotificationProvider>` sits inside `<AuthProvider>` (and inside `BrowserRouter`) in
  `main.jsx`. It reads `user`/`loading` from `useAuth`, so **no stream is opened before the session
  is established**, and it is not rendered twice.
- **Patient scoping:** the effect returns early unless `!loading && user?.role === 'patient'`, so
  doctor/admin sessions never connect. Setting `notifications` is skipped for other roles entirely.
- **Effect hygiene:** the effect depends only on `[loading, isPatient]`; its cleanup calls
  `stream.stop()`, so logout, role change and unmount all close the socket, cancel any pending retry
  and drop a ticket that is still in flight. Under React 19 `StrictMode` the double mount/unmount
  leaves exactly one connection (the first manager is stopped and its retries cancelled).
- **Event handling:** the manager parses `event.data` with `parseAssignment`, which returns `null` for
  a malformed frame; the frame is reported to `onError` and dropped, so bad data can never reach the
  UI. Only `waitlist.assigned` is registered, so other event names are ignored.
- **Display:** `NotificationBanner` (rendered by `Layout`, above the page content) shows the doctor,
  date and time of the reassigned appointment, links to
  `/patient/appointments/<appointmentId>`, and offers per-notice dismissal and "Dismiss all". It is a
  live region (`role="status"`, `aria-live="polite"`).
- **Duplicates:** `mergeNotification` replaces any entry with the same `appointmentId` and keeps the
  list at most 20 entries, so a reconnect that legitimately re-delivers an assignment — or a React
  remount — cannot produce a second banner.
- **State across tabs/sessions:** each tab owns its own connection (and its own banner), which is why
  multiple connections per user are supported server-side. Notifications are held in memory, so they
  are cleared by a page reload and by signing out (the effect empties the queue when the user stops
  being a patient), which prevents one patient from ever seeing another patient's notices.

## 10. Security and Privacy

- **Every stream is bound to a verified user.** The stream never reads a user id from the request;
  it uses the claim stored with the ticket, which was created from `req.user._id` behind the existing
  bearer/session middleware.
- **A user only receives their own events.** Verified at the unit level (one user's event reaches
  only that user's connections) and over HTTP (a stream opened for patient A receives nothing when
  patient B is notified, and `notifyUser(B, …)` reports `0` deliveries).
- **Ticket expiry and single-use are enforced server-side** (section 7), including a re-check that
  the bound session is still live.
- **No access token is ever placed in a URL**, and the ticket is not a substitute credential: it
  cannot call any other endpoint and it authorizes a single stream.
- **Query strings are never logged by the application.** `utils/audit.js` stores
  `String(originalUrl).split('?')[0]` for every record, so the ticket cannot reach the audit
  collection even though it arrives in a query string. The route does not log the URL either, and
  ticket errors are generic (`Invalid, expired or already used notification ticket`) with no stack.
- **Role authorization is untouched:** the ticket endpoint sits behind the same
  `protect` + `authorize('patient')` guards as other patient routes, and a denial is audited by the
  existing `rbac.access.denied` path. No CORS or global auth setting was relaxed — `EventSource`
  connects because the frontend origin is already in the `CLIENT_URL` allowlist.
- **Payload minimisation:** the event carries booking facts only. No clinical notes, no `reason`
  text, no contact details, no tokens, and no internal authorization data.
- **Bounded exposure from the URL itself:** a ticket can appear in the hosting layer's raw access
  logs (unavoidable for any query-parameter credential). Mitigations: 43 random characters, 30 s
  TTL, burned on first use, bound to one user, and useless for anything but opening one stream.

## 11. API Endpoints

| Method | Path | Access | Behaviour |
|---|---|---|---|
| `POST` | `/api/notifications/ticket` | Patient (`protect` + `authorize('patient')`) | `201` `{ success, message, data: { ticket, expiresIn } }`. `401` when unauthenticated / no session context; `403` for a non-patient role (audited); `503` when ticket issuance is unavailable. The body contains no identity or token material. |
| `GET` | `/api/notifications/stream?ticket=…` | Ticket in the query string (never `protect`) | `200` `text/event-stream` with `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`; then `retry: 30000`, `: connected`, `: ping` every 25 s and `event: waitlist.assigned` frames. `401` JSON for a missing/invalid/expired/used ticket or a revoked session; `503` JSON when the connection cap is reached. |

**`waitlist.assigned` payload (example):**

```json
{
  "appointmentId": "6710f1c2ab34cd56ef789012",
  "waitingListEntryId": "6710f1c2ab34cd56ef789001",
  "date": "2026-10-20",
  "startTime": "10:00",
  "endTime": "10:30",
  "doctorName": "Asha Rao",
  "specialization": "Cardiology",
  "status": "booked"
}
```

Delivered as:

```
event: waitlist.assigned
data: {"appointmentId":"6710f1c2ab34cd56ef789012", ...}

```

## 12. Environment and Deployment

### New environment variables (`backend/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `SSE_TICKET_TTL_MS` | `30000` | Lifetime of a stream ticket. Shorter is safer; longer only tolerates a slower first connection. |
| `SSE_MAX_TICKETS` | `5000` | Upper bound on unexpired tickets held in memory; the oldest are dropped first. |
| `SSE_HEARTBEAT_MS` | `25000` | Heartbeat (comment frame) interval. Must stay below the idle-connection timeout of any proxy in front of the API. |

No variable is required: the defaults are production-sane, and no new dependency was added
(`package.json` is unchanged for both apps). Redis is **not** required. A live Mongo connection is
required, exactly as before — the stream re-checks the session with `RefreshToken.exists`.

### Hosting considerations

- **Proxy idle timeouts:** Render/nginx are configured to reuse or drop idle sockets; the 25 s
  heartbeat plus `X-Accel-Buffering: no` are what keep a stream open and unbuffered. A CDN that
  buffers responses cannot be detected from here (see section 14).
- **CORS/credentials:** `CLIENT_URL` must contain the exact frontend origin; the `EventSource` request
  is cross-origin, and the existing CORS middleware already answers it with the allowlisted origin.
  `withCredentials` is not needed for the stream (the ticket is the credential), and the refresh
  cookie deliberately stays scoped to `/api/auth`.
- **Node server timeouts:** the stream disables the socket timeout for its own connection. If a future
  deploy sets `server.requestTimeout`/`server.headersTimeout` very low, keep them above the heartbeat
  interval.
- **Scaling:** the connection registry and the ticket store are in-process. Running more than one
  backend instance requires a shared fan-out (Redis pub/sub) and a shared atomic ticket store, as
  noted in the issue comments — see section 14. Nothing needs to change for a single instance.

## 13. Testing and Validation

Executed commands and **actual** results:

| Command | Location | Result |
|---|---|---|
| `node --check <each new/changed backend file>` | `backend/` | All 6 files parse |
| `npm test` (`node --test tests/*.test.js`) | `backend/` | **90 tests, 90 passed, 0 failed** — 47 pre-existing (5 `appointment` + 35 `authSecurity` + 7 `rbacAudit`) + **43 new** (23 `notificationService` + 9 `waitlistNotification` + 11 `notificationApi`) |
| `npm test` (`node --test tests/*.test.js`) | `frontend/` | **29 tests, 29 passed, 0 failed** — 13 pre-existing + **16 new** (`notificationStream.test.js`) |
| `npm run build` | `frontend/` | Succeeded (`✓ built in 447ms`); only the pre-existing `>500 kB` chunk-size advisory |
| `npm run lint` | either app | **Not run — unsupported.** Neither `package.json` defines a `lint` script, and the repository contains no ESLint/Biome configuration or linter binary. This is reported as unavailable, not as a pass. |

`notificationApi.test.js` runs the **real** Express app (`app.listen(0)`) with real HTTP requests and
real SSE framing; only `User.findById`, `RefreshToken.exists` and `AuditLog.create` are stubbed.
`notificationService.test.js` and `waitlistNotification.test.js` exercise the real service, the real
ticket store and the real `assignFromWaitingList`.

Coverage highlights:

**Notification service**
- a connected patient receives their own event in exact SSE framing, and a different patient's stream
  receives nothing;
- every open connection of one patient is served (multiple tabs), `ObjectId`/string identifiers
  address the same registrant, and the global user list is bounded (oldest stream evicted);
- `notifyUser` is a safe no-op for unknown/empty/offline users and for a missing event name;
- a destroyed response is never written to and is pruned; a `write()` that throws drops only that
  connection and the caller does not crash; `removeClient` is idempotent;
- heartbeats are `: ping` comments on the configured interval, contain no `event:` field, are
  `unref()`ed, and stop when the connection is removed (the default of 25 000 ms is asserted);
- `closeAll` and `removeUser` release exactly the intended connections.

**Ticket authentication**
- a ticket is issued once, bound to user + session, consumed once, and never accepted twice;
- tickets are random, stored only as their SHA-256 hash, and the hash itself cannot be presented as
  a ticket; issuance without a user identity returns `null`;
- empty/undefined/over-long/non-string/array values are rejected without touching the store;
- an expired ticket is refused *and burned* (it cannot be reused after expiry);
- 8 concurrent `consumeTicket` calls produce exactly 1 winner; over HTTP, 2 simultaneous stream
  requests produce exactly one `200` and one `401`;
- the store stays bounded (`SSE_MAX_TICKETS`) and drops the oldest entries, and issuance sweeps
  expired entries.

**SSE transport (HTTP)**
- `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` and the
  `retry: 30000` / `: connected` / `: ping` frames are all present;
- missing, empty, malformed, over-long, unknown and repeated `ticket` parameters → JSON `401` with
  no stack trace; a revoked session → `401`; a spent ticket → `401`;
- a stream opened for one patient receives nothing when another patient is notified, and receives the
  frame when it is; the other ticket opens its own (separate) stream;
- three concurrent streams for one patient are all registered and all released after disconnect
  (connection count returns to `0`);
- **end to end:** with a waiting-list patient's stream open, `PATCH /api/appointments/:id/cancel`
  returns `200` with `reassignedAppointmentId`, flips the entry to `assigned`, and the
  `waitlist.assigned` frame arrives on that patient's stream carrying the new appointment id, the
  waiting-list entry id, the date and the status — and none of the cancelled appointment's clinical
  notes.

**Waiting-list integration**
- a successful reassignment emits exactly one `waitlist.assigned` to the assigned patient, with the
  full expected payload and no clinical/contact/credential fields;
- the emission happens after `appointment.create` and `entry.save` (call order asserted);
- an injected notification failure still returns the persisted appointment and leaves the entry
  `assigned`; a missing/unpopulated doctor document degrades to an empty `doctorName` instead of
  failing;
- no event is emitted when there are no candidates, when the availability window vanished, when
  creation hits `11000`, or when the first candidate fails and a later one succeeds (only the actual
  recipient is notified);
- repeating the same cancellation produces no second event, and an offline patient is still assigned
  the slot.

**Frontend**
- backoff delays are bounded and non-decreasing (ceiling 30 s), including out-of-range attempts;
- the stream URL always URL-encodes the ticket and targets the configured API base;
- `parseAssignment` rejects 15 malformed shapes and strips unknown/sensitive frame fields;
  `mergeNotification` deduplicates by appointment and caps the list at 20;
- the lifecycle tests cover: one stream per `start()` with a ticket (and `start()` idempotence),
  `open` → `connected`, a delivered assignment, malformed frames kept out of the UI, reconnect with a
  *fresh* ticket and growing delays, a successful connection resetting the backoff, an unavailable
  backend retrying on schedule while `stop()` ends the loop and cancels every timer, `stop()` before
  a ticket resolves never opening a stream, post-`stop()` events being ignored, an empty ticket and a
  throwing `EventSource` factory being contained, and `stop()` being idempotent.

**Environment note (honest reporting):** this machine has no MongoDB and no Redis. Because
`backend/tests/*.test.js` deliberately stub the model calls they need, nothing here is reported as
failing — but a real database round trip was **not** exercised. Node was run from a portable
v24.21.0 unpacked outside the repository (`%TEMP%\node-portable`); dependencies were already
installed, so no lockfile changed.

**Frontend test scope (honest reporting):** the frontend runner is plain `node --test` and the
repository has no DOM harness (no jsdom, no testing-library), so no React component is rendered in
these tests. The two new React files are therefore covered by the production build plus the
manager-level tests: the mapping from a parsed event to context state is covered by
`mergeNotification` and by asserting the `onNotification` callback, while `NotificationContext` and
`NotificationBanner` themselves are exercised only by `vite build` and by review. Adding a DOM test
harness before writing component tests was considered out of scope (it would mean new dev
dependencies and runner changes, which the issue explicitly discourages).

### Manual verification still required

```bash
# 1. Backend: real database + two signed-in patients (A on the waiting list, B holding the slot)
cd backend && npm ci && cp .env.example .env   # set MONGO_URI, JWT_SECRET
npm run seed && npm run dev

# 2. As patient A: get a ticket and open the stream in a browser console
#    (or `curl -N`), then keep it open:
#      POST /api/notifications/ticket  -> ticket
#      curl -N "http://localhost:5000/api/notifications/stream?ticket=<ticket>"

# 3. As patient B (or their doctor/admin), cancel the booked appointment
#    -> expect `event: waitlist.assigned` within a second on A's stream
#    -> expect `: ping` comment frames roughly every 25 s
#    -> expect A's /patient/appointments page to show a banner without a refresh

# 4. Reconnect behaviour: stop the backend, watch the client retry with growing delays,
#    restart the backend, confirm a new ticket is requested and the stream recovers

# 5. Reuse a consumed ticket -> 401; wait 30 s with an unused ticket -> 401
```

## 14. Limitations and Follow-up Work

1. **Single-process only (the main constraint).** The connection registry and the ticket store are
   in-process, which matches the current single Render instance. To run more than one instance,
   `notifyUser` must fan out through a shared channel (the project already depends on `ioredis`,
   although `backend/config/redis.js` currently exposes only cache helpers and no pub/sub) and
   tickets must move to a shared atomic store (for example Redis `GETDEL` or a Lua script). The
   single-use guarantee documented in section 7 is a single-event-loop guarantee; it is **not** safe
   across processes.
2. **Tickets live in a URL.** Raw access logs at the hosting layer can record them. They are hashed
   at rest, expire in 30 s, are burned on first use, are bound to one user and authorize nothing else
   — but if a platform's access logs are retained and readable, that is an exposure this change
   cannot remove. Review log retention, and consider a short-lived stream cookie as a follow-up.
3. **Best-effort delivery, no queue.** If a patient has no open stream at the instant of the
   reassignment, the event is simply not delivered (the appointment is still created and appears in
   "My appointments" and on the waiting-list page). There is no persistence, no `Last-Event-ID`
   replay and no delivery receipt.
4. **A revoked session keeps an already-open stream** until the client reconnects — the session is
   re-checked when the stream is opened, not on every frame. Logout closes the stream client-side and
   the next ticket request fails, but a revoked session with a live socket would still receive frames
   for that user. A periodic re-authentication of the stream (or a revocation-triggered
   `removeUser`) would close it immediately.
5. **Stream open/close is not audited.** Auditing every reconnect would write a record per backoff
   step; worth revisiting together with (4) if administrators need stream visibility.
6. **Proxy buffering was not verified in production.** `X-Accel-Buffering: no` plus the heartbeat are
   the standard mitigations, but a CDN in front of the API could still buffer. This needs one manual
   check against the deployed environment.
7. **No cross-tab or persistent notification state.** Banners are per-tab and in memory, so a reload
   loses an undismissed notice and a second tab shows its own banner. `BroadcastChannel` and/or a
   session-scoped store would unify them (and the existing cross-tab broadcast gap for logout is the
   same shape of problem).
8. **SSE only, no fallback.** Environments that block long-lived HTTP responses (some corporate
   proxies) get no notifications; those patients still see the reassignment on their next page load.
   A polling fallback using the existing `GET /api/waiting-list/my` was intentionally not added.
9. **No load verification.** The per-user cap (10) and the global cap (5000) are reasoned bounds, not
   measured ones — a load test of many concurrent streams, and the memory per connection, is still
   outstanding.
10. **Notifications only for waiting-list reassignments.** The service is generic
    (`notifyUser(userId, event, data)`), so appointment reminders or doctor-side events could reuse it,
    but nothing else publishes to it yet, and there is no per-user preference/subscription model.
11. **`doctorName` costs one extra lookup** on an assignment when the doctor document is not already
    populated (rare, and never on the booking path). If that ever matters, the appointment could be
    populated once after creation instead.
12. **No React component tests.** The repository has no DOM test harness, so `NotificationContext`
    and `NotificationBanner` are verified by the production build and code review rather than by
    rendering them. The behaviour they depend on (ticket → stream → parse → merge → stop) is
    unit-tested directly. Adding jsdom/testing-library is a separate decision with new dev
    dependencies.
13. **No lint run.** The project defines no lint script and ships no linter configuration, so the
    new files were checked with `node --check`, the test suites and the production build only.

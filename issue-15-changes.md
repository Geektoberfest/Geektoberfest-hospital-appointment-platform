# Issue #15: Refresh Token Rotation, Multi-Device Session Revocation & RBAC Audit Logging

> File name note: sibling documentation uses `ISSUE_13_CHANGES.md` / `ISSUE_14_CHANGES.md`.
> This file keeps the name requested by the issue (`issue-15-changes.md`) and follows the
> same section structure and level of detail.

## 1. Issue Overview

**Issue #15 objective:** upgrade authentication from a single long-lived JWT in browser storage to
HttpOnly cookie refresh tokens with rotation, add per-device session listing and immediate
revocation, and record security-relevant events (RBAC denials, administrative changes, revocations,
token reuse) in an administrator-only audit log.

**Delivered:**

- Short-lived (15 minute default) access tokens that carry a `sid` session claim.
- Refresh tokens generated with `crypto.randomBytes(48)`, stored **only** as a SHA-256 hash, delivered
  in an `HttpOnly` cookie, and rotated on every use with an atomic, concurrency-safe claim.
- Reuse (replay) detection that revokes the affected session, plus a bounded 30-second grace window
  that keeps concurrent refreshes from logging each other out — without ever re-disclosing a
  consumed token.
- Multi-device session listing, single-session revocation and global revocation endpoints, and a
  `protect` middleware that checks the session against the database on **every** protected request so
  revocation is immediate.
- An `AuditLog` collection plus `GET /api/admin/audit-logs` (paginated, filterable, admin-only) and
  audit records for logins, registrations, logouts, refreshes, session revocations, RBAC/CSRF
  denials and administrative user/doctor changes.
- Frontend cookie credentials, CSRF double-submit handling, single-flight silent refresh on `401`,
  a session-management page for every role, and an admin audit-log viewer.

## 2. Problem Addressed

| # | Vulnerability / gap before this change | Resolution |
|---|---|---|
| 1 | Access tokens lived for 7 days (`JWT_EXPIRES_IN=7d`) and were readable by any script on the page (localStorage). | 15-minute access tokens; the long-lived credential is an `HttpOnly` cookie that JavaScript cannot read. |
| 2 | Logout was purely client-side: the JWT stayed valid until it expired. | Logout/revocation writes to the database; `protect` validates the session on every request. |
| 3 | There was no way to see or end a session on another device. | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `DELETE /api/auth/sessions`. |
| 4 | A stolen token could never be detected — there was no token state at all. | Refresh tokens are hashed at rest, rotated on use, and a replayed token revokes its session. |
| 5 | Roles were enforced but nothing recorded who was refused what. | `rbac.access.denied` (and `csrf.denied`) audit events with request correlation ids. |
| 6 | Administrative user/doctor changes left no trail. | `admin.user.*` / `admin.doctor.*` audit events (field *names* only, never values). |
| 7 | Cookie-based auth introduces CSRF risk. | Double-submit CSRF token required on `/api/auth/refresh` and `/api/auth/logout`; CORS `credentials` with an explicit origin allowlist (never `*`). |
| 8 | No audit access control existed because no audit log existed. | `/api/admin/audit-logs` sits behind the existing `protect` + `authorize('admin')` guard. |

## 3. Files Changed

### Backend — new

| File | Purpose |
|---|---|
| `backend/models/RefreshToken.js` | Refresh-token/session records: user, `sessionId`, `familyId`, hashed token, rotation/revocation metadata, device context, TTL index, and a partial unique index that guarantees one active token per session. |
| `backend/models/AuditLog.js` | Append-only security event records (action, outcome, actor, target, session, request id, request context, sanitized metadata). |
| `backend/utils/redact.js` | Dependency-free sanitizers: sensitive-key redaction, control-character flattening, length/depth caps, user-agent summarizer. |
| `backend/utils/tokenUtils.js` | Refresh-token crypto (generate/hash/validate), session ids, CSRF secret, cookie policy and minimal cookie-header parser. |
| `backend/utils/sessionStore.js` | Session/token persistence helpers shared by controllers (create session, issue token, revoke by filter, list, look up by hash). |
| `backend/utils/audit.js` | `AUDIT_ACTIONS` constants, request-context extraction and the never-throwing `recordAudit` writer. |
| `backend/middlewares/requestContext.js` | Request correlation id (`X-Request-Id`), cookie parsing, and the `requireCsrf` double-submit check. |
| `backend/controllers/sessionController.js` | Refresh rotation, logout, session listing/revocation. |
| `backend/controllers/adminAuditController.js` | Paginated + filtered audit-log queries with strict parameter validation. |
| `backend/tests/authSecurity.test.js` | 35 focused tests: models, crypto, cookie policy, middleware, rotation, replay, concurrent-rotation conflict, sessions, privileged-action auditing and redaction. |
| `backend/tests/rbacAudit.test.js` | 7 HTTP-level tests over the real Express app (401/403/200 on admin routes, CSRF, immediate revocation). |

### Backend — modified

| File | Change |
|---|---|
| `backend/controllers/authController.js` | Login/registration now create a session, set the refresh + CSRF cookies, sign session-bound access tokens, and audit success/failure. |
| `backend/controllers/userController.js` | Audits admin updates/deactivations and revokes the target user's sessions when their account is deactivated. |
| `backend/controllers/doctorController.js` | Audits admin doctor creation/update/deactivation and revokes sessions on deactivation. |
| `backend/middlewares/authMiddleware.js` | Verifies the JWT, then requires `sid` and confirms the session is still active in the database; fails closed on DB errors. |
| `backend/middlewares/roleMiddleware.js` | Audits role denials; documents that the role comes only from `req.user`. |
| `backend/middlewares/rateLimiter.js` | Adds `refreshRateLimiter` (60 / 15 min per IP) alongside the existing login/register limiter. |
| `backend/routes/authRoutes.js` | Adds `/refresh`, `/logout` (CSRF-protected) and `/sessions` routes. |
| `backend/routes/adminRoutes.js` | Adds `GET /audit-logs` under the existing admin guard. |
| `backend/utils/generateToken.js` | Signs `{ id, sid }` with `ACCESS_TOKEN_EXPIRES_IN` (default `15m`); refuses to sign without a session id. |
| `backend/utils/validators.js` | Adds `isValidSessionId` (UUID shape, rejected before any database call). |
| `backend/server.js` | `cors({ credentials: true })`, `requestContext` middleware, optional `TRUST_PROXY`. |
| `backend/.env.example` | Documents the new auth/session/cookie variables (`JWT_EXPIRES_IN` removed). |

### Frontend — new

| File | Purpose |
|---|---|
| `frontend/src/api/authSession.js` | `isRefreshExcluded`, `readCookie`, CSRF constants and the testable `createRefreshManager` single-flight/backoff coordinator. |
| `frontend/src/api/sessionApi.js` | `refresh`, `logout`, `listSessions`, `revokeSession`, `revokeAllSessions`. |
| `frontend/src/pages/Sessions.jsx` | Shared active-session UI (device list, per-device revoke, sign out of all devices). |
| `frontend/src/pages/admin/AuditLogs.jsx` | Admin audit viewer with action/outcome/search filters, pagination and empty/loading/error states. |
| `frontend/tests/authSession.test.js` | 6 tests for refresh coordination, exclusions, backoff and the cookie helper. |

### Frontend — modified

| File | Change |
|---|---|
| `frontend/src/api/axios.js` | `withCredentials: true`, CSRF header on mutating requests, silent single-flight refresh + one retry on `401`, terminal failure clears state. |
| `frontend/src/api/adminApi.js` | Adds `getAuditLogs(params)`. |
| `frontend/src/context/AuthContext.jsx` | `logout` now calls the API before clearing local state; exposes `clearSession`. |
| `frontend/src/components/common/Layout.jsx` | Adds a "Sessions" nav entry per role, "Audit Logs" for admins, awaits the API-backed logout. |
| `frontend/src/App.jsx` | Routes `/patient/sessions`, `/doctor/sessions`, `/admin/sessions`, `/admin/audit-logs`. |
| `README.md` | Backend env block updated (`ACCESS_TOKEN_EXPIRES_IN`, `TRUST_PROXY`) and the new endpoints added to the API table. |

## 4. Refresh Token Rotation

### Generation and storage

- The raw token is `crypto.randomBytes(48).toString('base64url')` — 64 URL-safe characters.
- Only `crypto.createHash('sha256').update(raw).digest('hex')` is persisted (`tokenHash`, unique index).
  No raw refresh token is written to the database, returned in JSON, put in a URL, or logged.
- A second hash field, `replacedByHash`, records which token replaced a rotated one. It is
  itself a hash, so the successor's raw value is **not** recoverable from the database.

### Cookie handling

| Attribute | Value |
|---|---|
| Name | `refresh_token` |
| `HttpOnly` | `true` (JavaScript can never read it) |
| `Secure` | `true` in production; forced `true` whenever `SameSite=None` |
| `SameSite` | `none` in production (Vercel frontend + Render API are different sites), `lax` in development |
| `Path` | `/api/auth` — the cookie is not attached to ordinary API traffic |
| `Max-Age` | `REFRESH_TOKEN_TTL_DAYS` (default 30 days) |

An accompanying `csrf_token` cookie is intentionally **not** `HttpOnly` (path `/`) because the
double-submit pattern requires our own JavaScript to echo it in the `X-CSRF-Token` header.
`clearAuthCookies()` mirrors the same path/security attributes so logout reliably removes both.

### Rotation and concurrency

1. The presented value is validated by shape first (`/^[A-Za-z0-9_-]{43,128}$/`); malformed values
   never reach the database.
2. Rotation claims the token with a single conditional update:
   `findOneAndUpdate({ tokenHash, revokedAt: null, expiresAt: { $gt: now } }, { $set: { revokedAt, rotatedAt, revokedReason: 'rotated' } })`.
   Only one concurrent request can match, so a token can be consumed exactly once.
3. The successor token is written with the same `sessionId`/`familyId`/`sessionStartedAt`, and the
   `Set-Cookie` response replaces the cookie value.
4. The partial unique index `{ sessionId: 1 } where revokedAt: null` makes "one active token per
   session" a database invariant: a racing request that tries to create a second live token gets a
   duplicate-key error (reported as `auth.refresh.concurrent_conflict`, no new chain, no kill switch).
5. Any refresh failure path clears the cookies; only the two legitimate success paths set them.

### Replay detection and the grace window

If the claim fails, the stored record decides what happens:

| Stored state | Behaviour |
|---|---|
| No record | `401` + `auth.refresh.failed` (unrecognised token), cookies cleared |
| Revoked for `logout` / `session_revoked*` | `401` + `auth.refresh.failed` (denied), no second revocation |
| Expired | `401` + `auth.refresh.expired`, **no** family revocation (a stale cookie must not become a denial-of-service switch for the live session) |
| Revoked with reason `rotated`, **outside** the grace window | Session revoked (`rotation_reuse_detected`) + `401` + `auth.refresh.reuse_detected` |
| Revoked with reason `rotated`, **inside** the grace window and the successor is still active in the same family | Treated as a legitimate concurrent refresh: `200` with a new access token, **no** new refresh cookie, **no** revocation, audited as `auth.refresh.concurrent_tolerated` |

The grace window is deliberately narrow:

- it only applies to tokens consumed by rotation (never to explicitly revoked tokens),
- it requires a live successor in the same family and an active account,
- it **does not** re-disclose or reconstruct the consumed replacement's raw value — the caller simply
  keeps the cookie that the winning request already set,
- it never creates a second token chain, and it never extends the session lifetime,
- it is configurable (`REFRESH_TOKEN_GRACE_MS`, default 30000, `0` disables it) and every use is audited.

See "Known Limitations" for the residual trade-off of this window.

## 5. Session Management

- Every successful login **and** registration calls `sessionStore.createSession()`, producing a new
  random `sessionId` (UUID) and `familyId` plus a fresh refresh token — so each device is a distinct
  session, even for the same user.
- The access token carries `sid: <sessionId>`. `protect` verifies the signature/expiry, then requires
  `RefreshToken.exists({ sessionId, user, revokedAt: null, expiresAt: { $gt: now } })`.
  Because this is checked per request, revocation is effective on the **next** call rather than after
  the access token expires. If the session store is unreachable the request fails closed with a `500`.
- Tokens without a `sid` claim (issued before this change) are rejected with a `401` instead of being
  trusted until expiry — there is no bypass that would keep revocation from applying.
- `GET /api/auth/sessions` returns only the caller's own active sessions (`user: req.user._id`),
  flags the current one, and selects non-sensitive fields only (`tokenHash`/`familyId` are never selected).
- `DELETE /api/auth/sessions/:id` looks the session up **scoped to the caller** (`user: req.user._id`),
  so another user's session is indistinguishable from a non-existent one (`404`); identifiers are
  UUID-validated before any query. Revoking the current session also clears the cookies.
- `DELETE /api/auth/sessions` revokes every session of the caller and clears the cookies.
- `POST /api/auth/logout` works from the refresh cookie alone (so it still succeeds after the access
  token expired), revokes only that session, clears both cookies, and is idempotent.
- Deactivating a user (directly, or by deactivating a doctor profile) revokes all of that user's
  sessions, so a later reactivation does not resurrect old devices.

## 6. RBAC Audit Logging

### Recorded events

| Action | Outcome | Trigger |
|---|---|---|
| `auth.register.success` | success | New patient/doctor account |
| `auth.login.success` / `auth.login.failed` | success / failure | Credential check |
| `auth.logout` | success | Device signed out |
| `auth.refresh.success` | success | Rotation succeeded |
| `auth.refresh.failed` | failure / denied | Missing, malformed, unknown or revoked token presented |
| `auth.refresh.expired` | failure | Expired refresh token presented |
| `auth.refresh.reuse_detected` | failure | Rotated token replayed outside the grace window |
| `auth.refresh.concurrent_tolerated` | success | Duplicate refresh inside the grace window |
| `auth.refresh.concurrent_conflict` | failure | Racing rotation that could not create a second chain |
| `auth.session.revoked` / `auth.session.revoked_all` | success | User revoked device(s) |
| `rbac.access.denied` | denied | Failed `authorize(...)` role check |
| `csrf.denied` | denied | Missing/mismatched CSRF token |
| `admin.user.updated` / `admin.user.deactivated` | success | Administrative user changes |
| `admin.doctor.created` / `admin.doctor.updated` / `admin.doctor.deactivated` | success | Administrative doctor changes |

### Structure

Each record stores: `action`, `outcome` (`success|failure|denied|error`), `actor` + `actorRole`,
`targetUser`/`targetType`/`targetId`, `sessionId`, `requestId`, minimal request context
(`method`, `path` **without query string**, `ip`, `userAgent`), a sanitized `description`, sanitized
`metadata`, and `createdAt`/`updatedAt` timestamps.

### Privacy and safety

- `utils/redact.js` replaces any value whose key looks sensitive
  (`password|secret|token|authorization|cookie|jwt|hash|otp|pin|csrf|credential|api key`) with
  `[redacted]`, including nested objects. A regression test asserts that no raw token, cookie or
  authorization header value can appear in a record.
- Control characters and newlines are flattened and values are length-capped, which prevents
  log-injection through user-controlled metadata.
- Query strings are stripped from the recorded path so a token sent in a URL is never persisted.
- Administrative updates record the **field names** that changed, never their values.
- Failed logins are recorded without the attempted email address (identifiers, not personal data).
- `recordAudit` never throws: it returns `{ ok: false, error }` and logs to stderr when persistence
  fails, so an audit outage cannot convert a successful security operation into a failed request —
  and no code path claims an event was audited when it was not.
- Audit records are readable **only** through `GET /api/admin/audit-logs`, which is mounted behind the
  existing `router.use(protect, authorize('admin'))` guard; ordinary users receive `403`.

### Admin endpoint

`GET /api/admin/audit-logs?page=&limit=&action=&outcome=&actor=&targetUser=&from=&to=&search=`

- `page` (default 1), `limit` (default 25, hard max 100), `total`/`pages` in the response.
- `action` must match `^[a-z0-9._-]{1,100}$`, `outcome` must be one of the enum values,
  `actor`/`targetUser` must be ObjectIds, `from`/`to` must parse as dates, and `search` is limited to
  `^[\w .@:-]{1,100}$` and regex-escaped — so filters cannot be used to inject operators or to widen
  access. Every invalid parameter returns `400` with the standard error envelope.
- Reads of the audit log are not themselves audited, deliberately: a record written by each page view
  would shift `total`/`page` while an administrator is paging through the log.

## 7. Frontend Integration

- The axios instance now uses `withCredentials: true`, so the HttpOnly refresh cookie travels with
  requests. CORS on the backend allows credentials only for the origins listed in `CLIENT_URL`.
- A request interceptor adds the access token from local storage (unchanged behaviour for existing
  calls) and, for `POST/PUT/PATCH/DELETE`, echoes the `csrf_token` cookie in the `X-CSRF-Token` header.
- A response interceptor reacts to `401` by running a **single-flight** refresh
  (`createRefreshManager`): concurrent callers await one shared promise, so one tab sends one refresh
  request. The original request is retried exactly once (`__isRetryRequest`), so no retry loop is possible.
- Login, registration and refresh responses are excluded from the refresh path, which prevents a
  failed login or a failing refresh from recursing.
- After a failed refresh the manager invokes `onLogout`, which removes the access token and dispatches
  the existing `auth:logout` event; `AuthContext` clears its state and `ProtectedRoute` redirects to
  `/login` (the application's existing navigation approach). A 5-second cooldown then prevents a burst
  of repeated refresh attempts on a terminally rejected session.
- The refresh token is never placed in local storage, session storage, application state or a URL —
  only the short-lived access token is kept client-side, exactly as before.
- `AuthContext.logout` calls `POST /api/auth/logout` and clears local state even if the call fails, so
  signing out always works from the user's point of view.
- `Sessions.jsx` is shared by all three roles (routes `/patient/sessions`, `/doctor/sessions`,
  `/admin/sessions`) and reuses the existing `DataTable`/`Alert`/`PageHeader`/`Spinner` components.
  `AuditLogs.jsx` reuses the same building blocks plus the admin API client. Both are conveniences:
  every permission check that matters is enforced server-side.

## 8. API Changes

| Method | Endpoint | Access | Purpose | Status codes |
|---|---|---|---|---|
| `POST` | `/api/auth/login` | Public (rate limited) | Now also creates a session and sets the refresh + CSRF cookies; returns a session-bound access token | `200`, `400`, `401`, `403` |
| `POST` | `/api/auth/register` | Public (rate limited) | Now also creates a session and sets the cookies | `201`, `400`, `403`, `409` |
| `POST` | `/api/auth/refresh` | Refresh cookie + `X-CSRF-Token` (rate limited) | Rotate the refresh token, return a new access token | `200`, `401`, `403` |
| `POST` | `/api/auth/logout` | Refresh cookie + `X-CSRF-Token` | Revoke this device's session, clear cookies | `200`, `403` |
| `GET` | `/api/auth/sessions` | Authenticated | List the caller's active sessions | `200`, `401`, `403` |
| `DELETE` | `/api/auth/sessions/:id` | Authenticated | Revoke one of the caller's sessions | `200`, `400`, `401`, `404` |
| `DELETE` | `/api/auth/sessions` | Authenticated | Revoke all of the caller's sessions | `200`, `401` |
| `GET` | `/api/admin/audit-logs` | Admin | Paginated, filterable audit trail | `200`, `400`, `401`, `403` |
| `GET` | `/api/auth/me` | Authenticated | Unchanged response, now session-validated | `200`, `401`, `403` |

Existing endpoint contracts are unchanged (`{ success, message, data }`), and login/registration still
return `data: { token, user, doctor }` so the current frontend flow keeps working. Refresh returns the
same shape. Sessions return an array whose `_id` is the opaque **session identifier** (a UUID, not a
Mongo ObjectId) so the existing table components work unchanged. Sample responses:

```json
// POST /api/auth/refresh  (200) - note the absence of any refresh token in the body
{
  "success": true,
  "message": "Token refreshed",
  "data": { "token": "<access token>", "user": { "_id": "…", "role": "patient" }, "doctor": null }
}
```

```json
// GET /api/auth/sessions  (200)
{
  "success": true,
  "message": "Active sessions retrieved",
  "data": [
    { "_id": "<session uuid>", "current": true, "device": "Chrome on Windows",
      "startedAt": "2026-10-13T09:00:00.000Z", "lastRefreshedAt": "2026-10-13T09:30:00.000Z",
      "expiresAt": "2026-11-12T09:00:00.000Z", "ip": "203.0.113.10" }
  ]
}
```

```json
// GET /api/admin/audit-logs?page=1&limit=25  (200)
{
  "success": true,
  "message": "Audit logs retrieved",
  "data": {
    "logs": [ { "_id": "…", "action": "rbac.access.denied", "outcome": "denied",
                "actor": "…", "actorRole": "patient", "path": "/api/admin/audit-logs",
                "requestId": "…", "description": "Role 'patient' is not allowed to access this resource" } ],
    "pagination": { "page": 1, "limit": 25, "total": 1, "pages": 1 }
  }
}
```

## 9. Security Considerations

- **Cookie attributes:** `HttpOnly`, `Secure` in production, `SameSite=None` only together with
  `Secure`, `Path=/api/auth`, bounded `Max-Age`. Clearing mirrors the same attributes.
- **CSRF:** the refresh cookie is cross-site in production, so both cookie-authenticated state-changing
  endpoints require a constant-time-compared double-submit token, and denials are audited. CORS uses
  `credentials: true` with an explicit origin allowlist from `CLIENT_URL` (never `*`), so a hostile
  origin cannot read responses either.
- **Secret redaction:** no refresh/access token, cookie value, password, password hash or
  authorization header can be written to an audit record; a test asserts this.
- **Concurrency:** rotation is an atomic conditional update plus a partial unique index, so two
  simultaneous refreshes cannot produce two valid token chains. The grace window never issues a second
  refresh token.
- **Immediate revocation:** the session is validated against the database on every protected request
  and the check fails closed on database errors.
- **Rate limiting:** `POST /api/auth/refresh` has its own limiter (60 / 15 min) in addition to the
  existing 5 / 15 min limiter on login and registration.
- **Least privilege:** a user can only list or revoke their own sessions; audit logs are admin-only
  server-side, and the role used for authorization always comes from the authenticated user document,
  never from request data.
- **Client-visible errors:** responses contain only the standard `{ success: false, message }` shape;
  stack traces are never returned (verified by tests) and internal errors are masked in production.
- **Trusted proxy:** `TRUST_PROXY` is opt-in so that rate limiting and audit `ip` fields report the
  real client address on Render/Vercel without blindly trusting forwarded headers elsewhere.

## 10. Environment and Database Changes

### New/updated environment variables (`backend/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `ACCESS_TOKEN_EXPIRES_IN` | `15m` | Access-token lifetime. **Replaces `JWT_EXPIRES_IN`, which is no longer read.** |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token/session lifetime in days. |
| `REFRESH_TOKEN_GRACE_MS` | `30000` | Concurrent-refresh grace window; `0` disables it (strict single-flight clients). |
| `REFRESH_COOKIE_SAMESITE` | `none` in production, `lax` otherwise | Cookie `SameSite` policy. |
| `REFRESH_COOKIE_SECURE` | `true` in production | Cookie `Secure` flag; forced `true` when `SameSite=None`. |
| `TRUST_PROXY` | unset | Set to `1` behind Render/Vercel so client IPs are real. |

`JWT_SECRET` and `CLIENT_URL` keep their existing meaning (`CLIENT_URL` still accepts a
comma-separated origin list and must list the frontend origin for credentialed requests to work).

### Database

- Two **new** collections are created lazily on first write: `refreshtokens` and `auditlogs`.
  No existing collection is altered, no data is migrated or deleted, and no backfill is required.
- Indexes added on `refreshtokens`: unique `tokenHash`; unique partial `{ sessionId }` where
  `revokedAt: null`; `{ user, revokedAt, expiresAt }`; `{ familyId, revokedAt }`; TTL on `expiresAt`
  (rows are removed 7 days after expiry so recent replay attempts stay auditable in the meantime).
- Indexes added on `auditlogs`: `{ createdAt: -1 }`, `{ action, createdAt }`, `{ outcome, createdAt }`,
  `{ actor, createdAt }`, `{ targetUser, createdAt }`, `{ requestId }`.
- `config/db.js` already runs `model.init()` for every registered model at startup, so these indexes
  are built automatically on the first boot after deployment.

### Deployment steps

1. Update the backend environment: add `ACCESS_TOKEN_EXPIRES_IN=15m` and `TRUST_PROXY=1`; remove
   `JWT_EXPIRES_IN`. Optionally set `REFRESH_TOKEN_TTL_DAYS`, `REFRESH_TOKEN_GRACE_MS` and the cookie
   overrides. Leave `CLIENT_URL` pointing at the deployed frontend origin.
2. Redeploy the backend, then the frontend (the frontend must send credentials and the CSRF header).
3. Expect every currently signed-in user to be signed out once: access tokens issued before this
   change have no `sid` claim and are rejected by design.
4. Ensure the two origins are served over HTTPS: production refresh cookies are `Secure`.

## 11. Validation and Testing

Executed commands and **actual** results:

| Command | Location | Result |
|---|---|---|
| `node --check <each changed backend file>` | `backend/` | All 20 files parse |
| `npm test` (`node --test tests/*.test.js`) | `backend/` | **47 tests, 47 passed, 0 failed** (5 pre-existing appointment tests + 35 new `authSecurity.test.js` + 7 new `rbacAudit.test.js`) |
| `npm test` (`node --test tests/*.test.js`) | `frontend/` | **13 tests, 13 passed, 0 failed** (7 pre-existing + 6 new `authSession.test.js`) |
| `npm run build` | `frontend/` | Succeeded (`✓ built in 1.61s`); only the pre-existing >500 kB chunk-size advisory |

Coverage highlights from `backend/tests/authSecurity.test.js`:

- login creates a distinct session per device, stores only the hash, and returns no refresh token;
- the refresh cookie is `HttpOnly` with `Path=/api/auth`, `Secure`+`SameSite=None` in production,
  `lax` offline in development, and `SameSite=None` is always paired with `Secure`;
- a valid refresh token rotates (atomic claim asserted on the filter/update), the cookie value changes,
  the stored hash matches the cookie, and the CSRF secret rotates too;
- missing/malformed/expired/revoked tokens are rejected, malformed values never hit the database, and
  an expired cookie cannot be used to revoke a live session;
- replaying a rotated token outside the window revokes exactly that session and is audited, while a
  duplicate inside the window is tolerated without a new token chain or a new cookie, and
  `REFRESH_TOKEN_GRACE_MS=0` makes every replay revoke;
- a losing concurrent rotation cannot create a second token chain (the partial unique index is
  surfaced as a controlled `401` with no cookie issued and no family revocation);
- administrative user updates/deactivations are audited with field **names** only and deactivation
  revokes every session of that user;
- session listing is scoped to the caller and never returns token material; revoking another user's
  session returns `404`; invalid identifiers return `400` without a database lookup; logout works
  without an access token and is idempotent;
- RBAC/CSRF denials are audited, and audit metadata/records contain no tokens, cookies or headers.

Coverage highlights from `backend/tests/rbacAudit.test.js` (real Express app over HTTP, no database):

- anonymous `GET /api/admin/audit-logs` → `401` with `X-Request-Id` present;
- patient and doctor → `403`, and the denial lands in the audit collection with the caller's identity;
- admin → `200` with `logs` + `pagination`; invalid `outcome`/`actor`/`action`/`search` → `400`;
- a revoked session makes an otherwise valid access token fail immediately with `401`;
- `POST /api/auth/refresh` without the CSRF header → `403`, and without a refresh cookie → `401`
  with no stack trace in the response.

**Environment note (honest reporting):** this machine had no Node.js runtime or MongoDB installed.
To run the suites I used a portable Node v24.21.0 unpacked into a temporary directory outside the
repository (`%TEMP%\node-portable`) and installed dependencies with `npm ci`. `npm ci` does not modify
`package-lock.json`. **No test was run against a live MongoDB instance** (none is available here):
model/stub-level tests exercise the rotation, revocation and audit logic, and the HTTP tests stub the
model calls they need. The real indexes, TTL behaviour and full login → refresh → revoke round trip
still need one run against a real database (see below).

### Manual verification still required

```bash
cd backend && npm ci && cp .env.example .env   # set MONGO_URI, JWT_SECRET
npm run seed && npm run dev

# 1. Login, capture cookies, confirm the refresh cookie is HttpOnly
curl -i -c cookies.txt -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"change_me_please"}'
grep refresh_token cookies.txt          # expect HttpOnly, path /api/auth

# 2. Rotate: reuse the csrf_token cookie value as the header
CSRF=$(awk '/csrf_token/{print $7}' cookies.txt)
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:5000/api/auth/refresh \
  -H "X-CSRF-Token: $CSRF"

# 3. Replay the previous refresh cookie value -> expect 401 and the session to be gone
# 4. List sessions, revoke one, then confirm an old access token is refused immediately
# 5. Confirm the admin audit log contains the reuse/denial events and no token material
```

## 12. Known Limitations and Follow-up Work

1. **Grace-window trade-off (documented, deliberate).** A rotated token replayed inside
   `REFRESH_TOKEN_GRACE_MS` (30 s) by an attacker who already stole it yields a short-lived access
   token for the still-active session; it never yields a new refresh token and never extends the
   session. Set `REFRESH_TOKEN_GRACE_MS=0` to remove the window entirely and rely on the client's
   single-flight refresh.
2. **One forced re-login at deployment.** Access tokens issued before this change carry no session id
   and are rejected (no insecure legacy bypass). This is intentional but must be communicated to users.
3. **No live database verification in this environment.** Rotation/revocation were verified with model
   stubs and HTTP tests, not against a real MongoDB. Run the manual checklist in section 11 before
   deploying.
4. **Administrators cannot revoke another user's sessions.** The endpoints are self-service only; an
   administrative session-management flow was intentionally left out of scope.
5. **`lastUsedAt` is refreshed on rotation, not on every request** (avoiding a database write per
   request). The UI therefore labels it "Last refreshed".
6. **Failed logins are audited without the attempted email**, keeping personal data out of the log at
   the cost of some forensic detail; the login rate limiter remains the primary brute-force control.
7. **Audit writes have no retry queue.** A failed write is reported (`ok: false`) and logged to stderr;
   it is never silently claimed as audited, but nothing re-attempts it.
8. **Audit-log reads are not audited** (so pagination stays stable) and there is no audit-log export.
9. **No cross-tab logout broadcast.** Signing out in one tab clears the cookie and session, so other
   tabs are signed out on their next request (or after their access token is rejected), but they are
   not notified immediately. A `BroadcastChannel` sync would be a small follow-up.
10. **No maximum session count per user.** Repeated logins create sessions until they expire (revoked
    and expired rows are cleaned up by the TTL index).
11. **Session list shows the requester's own IP addresses** in full; masking or geolocation was left out
    to avoid collecting additional data.
12. **No end-to-end coverage of the doctor/admin role-specific flows** beyond the HTTP tests for the
    admin audit endpoint; a full role matrix (patient/doctor/admin × every protected route) would be a
    worthwhile follow-up.

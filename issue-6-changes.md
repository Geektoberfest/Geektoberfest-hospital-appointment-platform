# Issue #6: Automated Unit & Integration Tests for Backend Auth & Registration

## 1. Issue Overview and Objective

[Issue #6](https://github.com/Geektoberfest/Geektoberfest-hospital-appointment-platform/issues/6)
asks for dependable automated tests around the existing authentication and registration API:
patient registration, doctor registration, duplicate-email handling (`409 Conflict`) and invalid
login credentials (`401 Unauthorized`).

The delivered work adds `backend/tests/auth.test.js` — **23 HTTP-level tests** that drive the real
Express application (routing, the auth rate limiter, the JSON body parser, the controllers, the
session/cookie helpers and the error envelope) against an in-memory stand-in for the database.

While writing them, the tests surfaced one genuine defect in
`backend/controllers/authController.js`: a registration or login request that carried **no JSON
body** answered `500` with an internal error message instead of a `400` validation error. That is
fixed with the smallest possible change (two lines, section 4), and the new suite locks the fixed
behaviour in.

## 2. Approach: HTTP-level tests with only the database faked

The project's test command is `node --test tests/*.test.js` and there is no jest/mocha/supertest
dependency, so the new file uses `node:test` plus the global `fetch` exactly like
`backend/tests/rbacAudit.test.js`, which already starts the real app with `app.listen(0)`.

| Layer | Real or faked | Why |
|---|---|---|
| Express routing, `express.json`, `notFound`/`errorHandler` | **Real** | The issue is about status codes and response shapes; only the real stack can prove them. |
| `authRateLimiter` (mounted in `server.js`) | **Real** | It is the one thing that cannot be observed below HTTP, so the mount point is verified too. |
| `authController.register` / `login` | **Real** | The behaviour under test. |
| `sessionStore.createSession`, `setAuthCookies`, `generateToken` | **Real** | Genuine session ids, real HttpOnly/CSRF cookies and a real signed JWT. |
| `User` / `Doctor` documents | **Real mongoose documents** | So `comparePassword`, the schema's `lowercase`/`trim` email handling and the `toJSON` password stripping are the production implementations, not mocks. |
| MongoDB (`findOne`, `create`, `deleteOne`, `findById`) | **Faked in memory** | No MongoDB is available in this environment; the fake mirrors the unique-index behaviour, including the `E11000` duplicate-key shape. |
| Redis | **Not used** (`REDIS_URL` unset) | `config/redis.js` returns early when no URL is configured, so cache calls are no-ops. No Redis process is needed. |

`User.findOne` returns a *query-like* object (awaitable **and** chainable onto `.select()`), because
the controller relies on both shapes; `Doctor.findOne` likewise returns a document with a chainable
`.populate()`. An early draft returned plain promises from those stubs and the suite failed with
`500` on doctor login — the stubs have to mirror the query API of the real driver, not just its
results.

Test data is entirely synthetic (`rosa.patient@example.com`, `Dana Doctor`, `CorrectHorse1`) and no
production configuration, credential or database is touched. Every password in the fake store is
hashed with the same `bcryptjs` at the same cost as the model's pre-save hook, so login really does
compare a bcrypt hash.

## 3. Test scenarios added

### Patient registration

| Test | What it asserts |
|---|---|
| `a valid patient registration returns 201, a session and no sensitive fields` | `201`, `{success, message:'Registration successful', data:{token, user, doctor:null}}`, the account exists exactly once with a hashed password, no `password`/hash/raw-refresh-token anywhere in the body, refresh cookie `HttpOnly` + `Path=/api/auth`, CSRF cookie readable, the stored refresh record keeps only the SHA-256 hash, the returned JWT verifies and carries the `sid` of that session, audit `auth.register.success` |
| `the email is normalised before it is stored or compared` | `  Rosa.Patient@Example.COM  ` is stored lowercased/trimmed, and the same address in another casing is a `409` rather than a second account |
| `registration rejects missing and invalid fields with 400 and creates nothing` | empty/whitespace name, malformed or empty email, short password, missing password, unknown role — each `400` with its exact message, no session, no cookie, no account, no success audit |
| `self-service admin creation is refused with 403` | `role: 'admin'` is refused and no account is created |
| `a malformed JSON body is answered with 400 instead of a server error` | truncated JSON → `400 Invalid JSON body` |
| `a request with no JSON body is a 400, not a server error` | no content type/no body and an empty JSON body → `400` validation messages, no internal error text leaked; top-level `null` → `400 Invalid JSON body` (see section 4) |

### Doctor registration

| Test | What it asserts |
|---|---|
| `a valid doctor registration creates both the user and the doctor profile` | `201`, `user.role === 'doctor'`, the doctor profile is created against the right department and returned populated, `User.create`/`Doctor.create` each run once, no secrets leak, auth cookies set, audit recorded with `actorRole: 'doctor'` |
| `doctor registration validates its own required fields` | missing/invalid `departmentId`, empty/missing `specialization` → `400`; the shared profile validator still applies (`experience: 90` → `400`); nothing persisted |
| `an unknown or inactive department is a 404 and no account is created` / `an inactive department is a 404 too` | `404 Department not found or inactive`, no user, no doctor profile |
| `a failed doctor profile write rolls the new user back instead of leaving an orphan` | a `Doctor.create` failure is rolled back (`User.deleteOne` called once), so no profile-less account and no session survive; the failure is still logged for the operator |

### Duplicate email

| Test | What it asserts |
|---|---|
| `registering an existing email returns 409 and does not create a second account` | `409 Email is already registered`, no `data`, no cookies, store size unchanged, `User.create` reached exactly once, only one success audit |
| `the duplicate check also covers doctor registration on an existing patient email` | a doctor cannot reuse a patient's address either (`409`, no doctor profile) |
| `a duplicate refused by the database constraint is still answered with 409` | with the pre-check blinded (stale read), the `E11000` propagated by the write is mapped by the error handler to `409 Duplicate record: this resource already exists`, with no account and no session left behind |
| `one account per email is enforced by the schema, not only by the controller` | `User.email` is `unique`/`lowercase`/`trim` and the unique email index exists on the schema; `Doctor.user` is unique — i.e. the constraint exists at both levels |

### Login

| Test | What it asserts |
|---|---|
| `login with valid credentials returns 200, a fresh session and no secrets` | `200 Login successful`, no secrets leaked, cookies set, register + login produce two distinct sessions, the stored hash matches the cookie value's hash, the JWT `sid` matches the new session, one success audit |
| `login as a doctor also returns the doctor profile` | doctor login returns `data.doctor` populated |
| `an unknown email and a wrong password answer identically with 401` | both are `401` with the **same** `Invalid email or password` message and no `data`; neither body contains the submitted password, the wrong password or a bcrypt hash; no session or cookie is created; both failures are audited as `auth.login.failed` and the attempted address is never written to the audit trail |
| `login without usable credentials is a 400` | missing body, missing password, empty password, malformed email → `400 Email and password are required` |
| `login is rejected for a password of the wrong type` | number, object (`$ne`-style operator), array, boolean and `null` passwords → `400`, never a bcrypt comparison against a non-string |
| `a deactivated account cannot log in even with the right password` | `403 Account is deactivated`, no session; the same account logs in again once reactivated |

### Harness reliability

| Test | What it asserts |
|---|---|
| `repeated attempts from one client are still rate limited` | five attempts from one client IP → `401`, the sixth → `429` with the limiter's message, proving the limiter is actually mounted on these routes |
| `the suite never opened a database connection` | `mongoose.connection.readyState === 0` at the end of the run — the tests could not have touched a real (let alone production) database |

## 4. Implementation fix (and why it was necessary)

`authController.register` and `authController.login` destructured `req.body` directly. Express 5
leaves `req.body` **undefined** when no body was parsed, so a request without a JSON content type
crashed inside the controller and the error handler turned it into a `500` — leaking an internal
`TypeError` message to the client and reporting a client mistake as a server failure.

Observed before the fix (temporary probe against the real app, now deleted):

```
POST /api/auth/register (no body, no content-type) -> 500
  {"success":false,"message":"Cannot destructure property 'name' of 'req.body' as it is undefined."}
POST /api/auth/login    (no body, no content-type) -> 500
  {"success":false,"message":"Cannot destructure property 'email' of 'req.body' as it is undefined."}
```

The fix is two lines, in the file the issue names:

```diff
 const register = asyncHandler(async (req, res) => {
-  const { name, email, password, role = 'patient', phone } = req.body;
+  // Express 5 leaves req.body undefined when nothing was parsed (a request without a JSON
+  // content type, for example), which is a validation error - not a 500.
+  const { name, email, password, role = 'patient', phone } = req.body || {};
 ...
 const login = asyncHandler(async (req, res) => {
-  const { email, password } = req.body;
+  const { email, password } = req.body || {}; // same guard as register
```

After the fix the same requests answer `400` with the ordinary validation messages
(`Name is required`, `Email and password are required`) and no internal text. Nothing else changes:
for any request that *is* JSON, `req.body` is the parsed object exactly as before, so the API
contract is untouched. No other endpoint was modified — the same pattern exists elsewhere in the
codebase, but it is outside this issue's scope (section 8).

## 5. Files Added or Modified

| File | Change | Why |
|---|---|---|
| `backend/tests/auth.test.js` | **Added.** 23 HTTP-level tests. | The deliverable required by the issue. |
| `backend/controllers/authController.js` | **Modified:** `req.body || {}` in `register` and `login` (plus one comment). | Defect found by the tests: a body-less request answered `500` instead of `400` (section 4). |

No other file was touched: no `package.json`, no test framework, no dependency, no model, no route,
no middleware and nothing under `frontend/`.

## 6. Commands Executed and Actual Results

**Environment note (honest reporting).** This machine has no `node`/`npm` on `PATH`. Node was run
from the portable official **v24.21.0** build already unpacked outside the repository
(`%TEMP%\node-portable\node-v24.21.0-win-x64`), so `npm test` was executed through its underlying
command, `node --test tests/*.test.js`. `backend/node_modules` was already installed: no install
step ran and no lockfile changed. There is no `backend/.env` in the tree, so `.env` injection is a
no-op (`injected env (0) from .env`) and no `MONGODB_URI`/`REDIS_URL` is configured.

| Command | Location | Result |
|---|---|---|
| `node --test tests/auth.test.js` | `backend/` | **23 tests, 23 passed, 0 failed** (exit 0, ~2.0 s) |
| `node --test tests/*.test.js` (the `npm test` command), run 1 | `backend/` | **113 tests, 113 passed, 0 failed** (exit 0, 4160 ms) |
| `node --test tests/*.test.js`, run 2 (immediately repeated) | `backend/` | **113 tests, 113 passed, 0 failed** (exit 0, 4080 ms) — identical result, no leftover state |
| `node --test --test-name-pattern="login with valid credentials" tests/auth.test.js` | `backend/` | 1 test, 1 passed (exit 0) — passes in isolation |
| `node --test --test-name-pattern="duplicate" tests/auth.test.js` | `backend/` | 2 tests, 2 passed (exit 0) |
| `node --test --test-name-pattern="no JSON body" tests/auth.test.js` | `backend/` | 1 test, 1 passed (exit 0) — the regression test for section 4 |
| Temporary probe script (deleted afterwards) | `backend/` | Reproduced the pre-fix `500` responses quoted in section 4 |

113 = 90 pre-existing backend tests + the 23 new ones; the pre-existing suites
(`appointment`, `authSecurity`, `notificationApi`, `notificationService`, `rbacAudit`,
`waitlistNotification`) are unaffected by the controller change and still pass.

**Lint: not run — not supported by this repository.** Neither `backend/package.json` nor
`frontend/package.json` declares a `lint` script and there is no ESLint/Biome configuration or lint
binary in the tree. Reported as unavailable, not as a pass.

**Frontend suite: not run.** The change is confined to `backend/`, and the frontend suite
(`node --test tests/*.test.js` in `frontend/`) is unaffected.

## 7. Isolation, Repeatability and Cleanup

- **No shared state between tests.** `test.beforeEach` resets the in-memory account store and the
  captured write lists, so a test can neither see another test's records nor depend on running
  after it. Each test registers its own addresses.
- **Overrides cannot leak.** Per-test database overrides are installed through a helper that
  restores the previous implementation in `t.after`, and the defaults installed once in
  `test.before` are restored in `test.after`.
- **No rate-limit coupling.** The limiter keys on the client IP, so every request uses its own
  `X-Forwarded-For` value (`TRUST_PROXY`-style, matching how the API is deployed) and the suite
  cannot exhaust a bucket for a later test. The one test that *wants* the limiter uses a fixed IP.
- **Deterministic and repeatable.** Run twice back to back with identical results (section 6), and
  individual tests pass in isolation.
- **Cleanup.** There is nothing to clean up in a database because none is used: the suite never
  opens a connection (asserted), and the fake store is dropped with the process. Failed
  registrations are additionally asserted to create neither an account nor a session.

## 8. Remaining Issues and Limitations

1. **No real MongoDB was exercised.** The unique-index enforcement path is covered by simulating an
   `E11000` error at the database boundary and by asserting the schema declares the unique index,
   but a genuine duplicate-key error raised by MongoDB itself was not triggered here. A suite run
   against a real (dedicated, test-only) MongoDB would be the strongest form of this check — that
   environment is not available in this repository, so the limitation is reported rather than
   hidden.
2. **The rate limiter's exact policy is pinned.** `repeated attempts from one client are still rate
   limited` asserts five attempts then `429`, which matches `backend/middlewares/rateLimiter.js`
   today. Deliberately changing that policy means updating the test — that is intended, but it is
   worth knowing the number is asserted rather than derived.
3. **The same `req.body` pattern exists elsewhere.** The fix was applied only to `register` and
   `login`, the two endpoints this issue names. Other controllers that destructure `req.body`
   directly will answer `500` for a body-less request in the same way; auditing them is a separate
   change.
4. **Hashing in the fake store bypasses the model hook.** The fake `User.create` hashes with
   `bcryptjs` at the same cost as the model's `pre`-`save` hook instead of calling the hook, so the
   hook itself is still not exercised by an automated test (a real `save()` needs a database).
   Login therefore compares a genuine bcrypt hash, which is the security-relevant half.
5. **Only the auth/registration surface is covered.** Refresh rotation, logout, session listing and
   revocation are tested in `authSecurity.test.js` and `rbacAudit.test.js` at the controller level;
   they are not re-tested over HTTP here.

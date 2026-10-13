# Issue #5: Unit Tests for Frontend Formatters & Validation Helpers

> File name note: sibling documentation uses `ISSUE_13_CHANGES.md` / `ISSUE_14_CHANGES.md`, while
> issues #11 and #15 use lower-case names (`issue-11-changes.md`, `issue-15-changes.md`). This file
> keeps the name requested by the issue (`issue-5-changes.md`) and follows the same section
> structure and level of detail.

## 1. Issue Overview and Objective

**Objective:** add reliable unit tests for the frontend formatter and validation helpers
(`isValidEmail`, `formatDate`, `formatTime`, `getErrorMessage`) so that UI-facing formatting and
error-message logic is covered by automated tests, **without changing working application code**.

**Delivered:**

- `frontend/tests/utils.test.js` — 25 focused tests (5 for `isValidEmail`, 8 for `formatDate`,
  6 for `formatTime`, 6 for `getErrorMessage`) written against the actual behaviour of the current
  implementation and its callers, using the project's existing runner (`node --test`) and no new
  dependency.
- One required one-line fix in `frontend/src/utils/validation.js` (an ESM import extension) so the
  module can be loaded by the test runner at all — see section 6.
- No application behaviour was changed: the single source edit is an import specifier, and the
  production build output is unaffected.

## 2. Functions Covered by the Test Suite

| Function | Module | What it does | Who calls it |
|---|---|---|---|
| `isValidEmail(v)` | `frontend/src/utils/validation.js` | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v \|\| '').trim())` — shape check for an email address | `pages/auth/Login.jsx`, `pages/auth/Register.jsx`, `pages/admin/Doctors.jsx` (all pass form-state strings) |
| `formatDate(s)` | `frontend/src/utils/format.js` | `"YYYY-MM-DD"` → `en-GB` short date (`Fri, 10 Jan 2025`), built from **local** date components; `'-'` for falsy input | `components/appointments/AppointmentList.jsx`, `components/appointments/AppointmentDetail.jsx`, `components/common/NotificationBanner.jsx`, patient/doctor/admin pages |
| `formatTime(t)` | `frontend/src/utils/format.js` | `"HH:MM"` (24-hour) → 12-hour label (`1:05 PM`); `'-'` for falsy input | `SlotGrid.jsx`, `AppointmentList.jsx`, `AppointmentDetail.jsx`, `NotificationBanner.jsx`, waiting-list pages |
| `getErrorMessage(err)` | `frontend/src/utils/format.js` | `err.response.data.message` → (`err.request` ? "Cannot reach the server…") → `err.message` → `"Something went wrong"` | `hooks/useFetch.js` and most page-level `catch` blocks |

The expectations were derived from the implementations themselves **and** from how the values reach
them: the API validates dates and times (`isValidDate`, `isValidTime` in `backend/utils/validators.js`)
before storing them, and every `isValidEmail` caller passes a form-state string. That is why the tests
assert the supported contract exactly and characterize (rather than "fix") the unsupported inputs.

## 3. Test Cases Added

### `isValidEmail` — 5 tests

| Test | Cases |
|---|---|
| accepts normally formatted addresses | `a@b.com`, `user@example.co.uk`, `first.last+tag@sub.domain.org`, `UPPER@Example.COM`, `a1@b2.io`, `name-with-dash@my-host.example.com` |
| requires an `@` and a dotted domain | `plainaddress`, `a@b`, `@b.com`, `a@.com`, `a@b.`, `a b@c.com`, `a@b c.com`, `two@@at.com` |
| trims surrounding whitespace before testing | `'  user@example.co.uk  '`, `'\t\n  user@example.co.uk \r\n'` → `true`; `'   '`, `'\t\n '` → `false` |
| treats empty and missing values as invalid without throwing | `''`, `null`, `undefined`, `0`, `false`, `NaN` |
| is not safe for non-string input (documented limitation) | `42`, `{}`, `['a@b.com']` (see section 8) |

### `formatDate` — 8 tests

| Test | Cases |
|---|---|
| renders a fixed date with weekday, day, month and year | `'2025-01-10'` → tokens `Fri`, `10`, `Jan`, `2025` |
| matches the `en-GB` short format for the same calendar day | `'2025-01-10'`, `'2025-06-15'`, `'2026-10-14'` against an independently constructed expectation (section 5) |
| does not shift the calendar day at year boundaries | `'2025-01-01'` → `Wed`, no `2024`/`Dec`; `'2025-12-31'` → `Wed`, no `2026`/`Jan` |
| handles a leap day | `'2024-02-29'` → `Thu 29 Feb 2024` |
| formats past dates without depending on the current date | `'1999-12-31'` → `Fri … 1999` |
| returns a placeholder for empty or missing values | `''`, `undefined`, `null`, `0` → `'-'` |
| does not throw on a malformed value and flags it as invalid | `'not-a-date'`, `'abc'` → matches `/invalid date/i` |
| rolls out-of-range components over instead of rejecting them | `'2025-13-45'` → 14 Feb 2026 (characterized, see section 8) |

### `formatTime` — 6 tests

| Test | Cases |
|---|---|
| renders morning times without a leading zero | `00:00` → `12:00 AM`, `00:30` → `12:30 AM`, `09:05` → `9:05 AM`, `11:59` → `11:59 AM` |
| keeps noon and early afternoon on the PM boundary | `12:00` → `12:00 PM`, `12:45` → `12:45 PM` |
| renders afternoon and evening times | `13:05` → `1:05 PM`, `15:30` → `3:30 PM`, `23:59` → `11:59 PM` |
| pads minutes and never pads the hour | `08:00` → `8:00 AM`, `08:07` → `8:07 AM`, `20:07` → `8:07 PM` |
| returns a placeholder for empty or missing values | `''`, `undefined`, `null`, `0` → `'-'` |
| does not guard malformed strings (characterized, not endorsed) | `'not-a-time'` → `'12:undefined AM'`, `'12'` → `'12:undefined PM'` (see section 8) |

### `getErrorMessage` — 6 tests

| Test | Cases |
|---|---|
| prefers the message from the API response envelope | `{ response: { data: { message: 'Invalid email or password' } } }`; extra envelope fields (`success`, nested `data`) are ignored |
| reports an unreachable backend when there is no response | `{ request: {}, message: 'Network Error' }`, `{ request: { status: undefined } }` → `'Cannot reach the server. Is the API running?'` |
| falls back to the error message for plain errors | `new Error('Something broke')`, `{ message: 'Unexpected token' }` |
| uses a generic fallback for unknown or empty shapes | `{}`, `[]`, `undefined`, `null`, `'boom'`, `0`, `false`, `true` → `'Something went wrong'` |
| ignores a response that carries no usable message | `{ response: { data: {} }, message: '… status code 400' }`, empty-string message, non-object body → falls through to `err.message` |
| does not treat a missing response object as an unreachable server | `{ response: null, message: 'fallback message' }` → `'fallback message'`; `{ response: { data: null } }` → generic |

## 4. Edge Cases and Invalid Inputs Covered

- **Empty and missing input:** `''`, whitespace-only, `null`, `undefined`, `0`, `false`, `NaN` for all
  three value-taking helpers (`formatDate` and `formatTime` return `'-'`; `isValidEmail` returns
  `false`). Note that `formatDate`/`formatTime` guard with a truthiness check, so even the non-string
  falsy values are safe, while `isValidEmail` only becomes unsafe for *truthy* non-strings
  (section 8, item 1).
- **Malformed strings:** non-date (`'not-a-date'`, `'abc'`), non-time (`'not-a-time'`, `'12'`), and
  out-of-range date components (`'2025-13-45'`) — asserted to be non-throwing and characterized.
- **Boundary values:** midnight `00:00`, `00:30`, noon `12:00`, the 11:59/12:00/12:45 AM↔PM
  transition, the last minute `23:59`, 1 January, 31 December, and a leap day.
- **Whitespace:** leading/trailing spaces and tabs/newlines around an otherwise valid email.
- **Email structure:** missing `@`, missing local part, missing domain label, missing TLD, empty TLD
  segment, embedded whitespace, and a doubled `@`.
- **Error shapes:** axios server error (response envelope), axios network error (`request` only),
  plain `Error`, plain object with `message`, empty string message, `response: null`, `data: null`,
  non-object body, and primitives/arrays/booleans.
- **Precedence:** the error-message chain `response.data.message` → `request` sentinel →
  `err.message` → generic is asserted in every direction, including the two less obvious ones (a
  response *without* a usable message falls through to `err.message`; `response: null` does **not**
  produce the "server unreachable" sentinel).

## 5. How Date/Time Test Determinism Is Handled

`formatDate` is the only helper that touches locale/time primitives, so it needed care. Both of its
risk areas — the machine timezone and the runtime's ICU data — are handled without weakening the
assertions:

1. **No dependence on "now".** Every date assertion uses a fixed literal input, including
   deliberately historical (`'1999-12-31'`), boundary (`'2025-01-01'`, `'2025-12-31'`) and leap
   (`'2024-02-29'`) values. Nothing in the suite reads the current date or clock.
2. **Locale/ICU independence.** The exact-format expectation is computed by the test with the same
   API from independently supplied numeric components:
   `new Date(year, monthIndex, day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })`.
   Comparing against a *runtime-computed* expectation keeps the test valid on a Node build that
   falls back to `en-US` ICU data (where the same request renders `Fri, Jan 10, 2025`), while still
   pinning what actually matters: the input parsing (`2025-01-10` must be 10 January 2025), the
   local-component date construction, and the exact format options. A hard-coded `'Fri, 10 Jan 2025'`
   literal would break on small-ICU builds, so it is deliberately avoided.
3. **Locale-independent token assertions.** Every dated case (a fixed date, the year boundaries, the
   leap day, the historical date and the rollover case) *additionally* asserts the weekday (`Fri`,
   `Wed`, `Thu`, `Sat`), the month (`Jan`, `Feb`) and the year as separate tokens, and the canonical
   case (`'2025-01-10'`) also asserts the day number (`10`). Tokens hold under any `en-*` rendering,
   so a wrong weekday, month or year fails even if the ICU fallback changes the ordering or
   separators. The placeholder and malformed-input cases assert `'-'` / `/invalid date/i` instead,
   because there is no calendar day to tokenize.
4. **Timezone-shift regression guard.** `'2025-01-01'` must not render `Dec`/`2024` and `'2025-12-31'`
   must not render `Jan`/`2026`. This is the assertion that fails if someone replaces the
   local-component construction with `new Date('YYYY-MM-DD')` (UTC parsing), which shifts the day
   backwards in negative-offset timezones.
5. **Empirically verified, not assumed.** The suite was executed in five timezones — `UTC`,
   `America/Los_Angeles` (UTC−8), `Pacific/Kiritimati` (UTC+14), `Asia/Calcutta` and
   `Australia/Sydney` — and reported 25/25 passing in every one (section 7). `formatTime` is pure
   string arithmetic on `HH:MM`, so it has no timezone or locale dependency at all.

## 6. Files Added or Modified

| File | Change | Why |
|---|---|---|
| `frontend/tests/utils.test.js` | **Added.** 25 tests covering the four helpers. | The deliverable required by the issue. |
| `frontend/src/utils/validation.js` | **Modified:** one import specifier, `from './format'` → `from './format.js'` (plus an explanatory comment). | **Required, not cosmetic.** The file previously imported `./format` without an extension, which plain Node ESM cannot resolve, so `tests/utils.test.js` could not import `isValidEmail` at all (the runner fails with `ERR_MODULE_NOT_FOUND`). This is the same constraint already documented in `frontend/src/api/axios.js` ("Explicit .js extension keeps this module loadable by plain Node ESM (the test runner)"). Vite resolves both forms, so the application build is unaffected, and the module's exports and behaviour are unchanged. |

No other file was touched: no application logic, no test-framework change, no new dependency, and no
change to either `package.json`.

## 7. Commands Used and Actual Results

| Command | Location | Result |
|---|---|---|
| `node --test tests/utils.test.js` | `frontend/` | **25 tests, 25 passed, 0 failed** (exit 0) |
| `TZ=<zone> node --test tests/utils.test.js` for `UTC`, `America/Los_Angeles`, `Pacific/Kiritimati`, `Asia/Calcutta`, `Australia/Sydney` | `frontend/` | **25 passed / 0 failed in every timezone** — the date assertions are deterministic |
| `npm test` (`node --test tests/*.test.js`) | `frontend/` | **54 tests, 54 passed, 0 failed** (exit 0) — 29 pre-existing + the 25 new ones |
| `npm run build` (`vite build`) | `frontend/` | Succeeded (**exit 0**, `✓ built in 842ms`, 716 modules); only the pre-existing `>500 kB` chunk-size advisory |
| `node -e "…"` behaviour probe of all four helpers | `frontend/` | Used to derive every expected value **before** writing assertions, instead of assuming behaviour from the function names |

**Environment note (honest reporting):** this machine has no `npm`/Node on `PATH` by default. Node
was run from a portable official **v24.21.0** build unpacked outside the repository
(`%TEMP%\node-portable`); `frontend/node_modules` was already installed, so no install step ran and
no lockfile changed. The build was run with the project's existing `npm run build` script.

**Lint:** not run — **not supported by this repository.** Neither `package.json` declares a `lint`
script, and there is no ESLint/Biome configuration or linter binary in the tree. This is reported as
unavailable, not as a pass.

**Backend tests:** not re-run. This change touches only `frontend/` files (one import specifier and
one new test file), so the backend suite is unaffected.

## 8. Remaining Issues and Follow-up Work

No test in this suite is skipped or weakened, and no assertion was relaxed to make a test pass. The
following are **observed characteristics of the current implementations that the tests document but
deliberately do not change**. Each one is unreachable from the UI today (its callers constrain the
input), and the issue asked to improve coverage "without unnecessarily changing working application
code", so the smallest correct change was to record the behaviour and report it here.

1. **`isValidEmail` throws on truthy non-strings.** The implementation is `(v || '').trim()`, so
   `isValidEmail(42)`, `isValidEmail({})` or `isValidEmail(['a@b.com'])` raise
   `TypeError: … .trim is not a function`; falsy values (`null`, `undefined`, `''`, `0`, `false`,
   `NaN`) are handled safely and return `false`. All three callers pass form-state strings, so this
   is latent. A one-line hardening would be
   `const isValidEmail = (v) => typeof v === 'string' && /…/.test(v.trim());` — not applied here
   because it changes behaviour of working code and is out of scope for a test-only issue. A test
   named as a documented limitation pins the current behaviour, so the fix (if ever made) is a
   deliberate change.
2. **`formatTime` does not guard malformed strings.** `formatTime('not-a-time')` returns
   `'12:undefined AM'` and `formatTime('12')` returns `'12:undefined PM'` (the `NaN` hour falls into
   the `|| 12` branch and the undefined minutes are stringified). Falsy input is handled (`'-'`), and
   the API validates every stored time with a strict `HH:MM` regex, so the UI never reaches this
   path. A guard such as `if (!/^\d{2}:\d{2}$/.test(t)) return '-';` would remove it; the test
   records the current output instead ("characterized, not endorsed").
3. **`formatDate` normalizes out-of-range components.** `formatDate('2025-13-45')` renders
   `Sat, 14 Feb 2026` rather than rejecting the value, because `new Date(y, m - 1, d)` rolls month 13
   and day 45 forward. Non-numeric input (`'not-a-date'`) renders `Invalid Date`. Again unreachable
   from the UI (the API validates the `YYYY-MM-DD` shape, including real calendar days, before
   storing), and the test documents the rollover.
4. **`formatDate` output depends on the runtime's ICU data for the *ordering* only.** The suite is
   written to pass with either full ICU (`en-GB`: `Fri, 10 Jan 2025`) or a small-ICU `en-US` fallback
   (`Fri, Jan 10, 2025`). If the project ever needs a byte-identical rendering on every runtime, the
   helper itself would have to format the components explicitly instead of delegating to
   `toLocaleDateString`.
5. **Not covered by this suite (out of scope).** The issue lists exactly four functions, so
   `doctorName`, `todayString`, `nowTimeString`, `isPastValue` (all in `frontend/src/utils/format.js`)
   and `validateDate` / `validateAvailability` (`frontend/src/utils/validation.js`) have no tests
   yet. The two "now" helpers and `isPastValue` are inherently clock-dependent and would need
   injectable time (or fake timers) to test deterministically — a natural follow-up.
6. **No component-level tests.** The repository has no DOM test harness (no jsdom, no
   testing-library), so these tests cover the pure helpers only; the pages that consume them are
   covered by the production build and review. Adding a DOM harness is a separate decision with new
   dev dependencies.
7. **No coverage measurement.** The project has no coverage tooling, so the statements added by this
   suite are not quantified; the claim here is limited to which behaviours are now asserted.

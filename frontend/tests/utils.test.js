import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDate, formatTime, getErrorMessage } from '../src/utils/format.js';
import { isValidEmail } from '../src/utils/validation.js';

/**
 * Unit tests for the frontend formatter/validation helpers used across the UI
 * (issue #5): `isValidEmail`, `formatDate`, `formatTime` and `getErrorMessage`.
 *
 * Every expectation below was derived from the current implementation and its callers, not
 * from the function names:
 *
 * - `isValidEmail` is used by the login, register and admin-doctor forms, which always pass
 *   a string taken from form state.
 * - `formatDate` / `formatTime` render backend values that the API validates first
 *   (`isValidDate` / `isValidTime` in `backend/utils/validators.js`), so they only ever
 *   receive `YYYY-MM-DD` and `HH:MM` strings in the application.
 * - `getErrorMessage` is called from `catch` blocks with axios errors, whose response body
 *   is the API envelope `{ success, message, data }`.
 */

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

test('isValidEmail accepts normally formatted addresses', () => {
  for (const email of [
    'a@b.com',
    'user@example.co.uk',
    'first.last+tag@sub.domain.org',
    'UPPER@Example.COM',
    'a1@b2.io',
    'name-with-dash@my-host.example.com',
  ]) {
    assert.equal(isValidEmail(email), true, `expected ${email} to be valid`);
  }
});

test('isValidEmail requires an @ and a dotted domain', () => {
  for (const email of [
    'plainaddress',
    'a@b', // no TLD separator
    '@b.com', // no local part
    'a@.com', // no domain label
    'a@b.', // nothing after the dot
    'a b@c.com', // whitespace inside the address
    'a@b c.com',
    'two@@at.com',
  ]) {
    assert.equal(isValidEmail(email), false, `expected ${email} to be invalid`);
  }
});

test('isValidEmail trims surrounding whitespace before testing', () => {
  assert.equal(isValidEmail('  user@example.co.uk  '), true);
  assert.equal(isValidEmail('\t\n  user@example.co.uk \r\n'), true);
  // Whitespace-only input becomes an empty string, which is not a valid address.
  assert.equal(isValidEmail('   '), false);
  assert.equal(isValidEmail('\t\n '), false);
});

test('isValidEmail treats empty and missing values as invalid without throwing', () => {
  for (const value of ['', null, undefined, 0, false, NaN]) {
    assert.equal(isValidEmail(value), false, `expected ${String(value)} to be invalid`);
  }
});

test('isValidEmail is not safe for non-string input (documented limitation)', () => {
  // The implementation is `(v || '').trim()`, so a truthy non-string reaches `.trim()` and
  // throws. This is unreachable from the UI (all three callers pass form-state strings and
  // guard with this function), so it is characterized here rather than "fixed": changing it
  // would be a behaviour change to working code, outside the scope of adding tests.
  for (const value of [42, {}, ['a@b.com']]) {
    assert.throws(() => isValidEmail(value), TypeError, `expected ${JSON.stringify(value)} to throw`);
  }
});

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * The `en-GB` short rendering of a calendar day, built from numeric components exactly the
 * way `formatDate` does. Building the expectation with the same API keeps the assertions
 * independent of the machine locale/timezone while still pinning the parsing (year, month,
 * day) and the format options (`weekday/day/month/year`, short forms).
 */
const shortDate = (year, monthIndex, day) =>
  new Date(year, monthIndex, day).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

test('formatDate renders a fixed date with weekday, day, month and year', () => {
  const formatted = formatDate('2025-01-10'); // a Friday

  // Locale-independent token checks: every en-* rendering contains these tokens, and a
  // wrong month, day, weekday or year fails here regardless of the ICU data available.
  assert.match(formatted, /Fri/);
  assert.match(formatted, /\b10\b/);
  assert.match(formatted, /Jan/);
  assert.match(formatted, /2025/);
});

test('formatDate matches the en-GB short format for the same calendar day', () => {
  assert.equal(formatDate('2025-01-10'), shortDate(2025, 0, 10));
  assert.equal(formatDate('2025-06-15'), shortDate(2025, 5, 15));
  assert.equal(formatDate('2026-10-14'), shortDate(2026, 9, 14));
});

test('formatDate does not shift the calendar day at year boundaries', () => {
  // Parsing "2025-01-01" as UTC would render 31 Dec 2024 in any negative-offset timezone;
  // the implementation builds a local Date from the components, so the day never moves.
  const newYear = formatDate('2025-01-01');
  assert.equal(newYear, shortDate(2025, 0, 1));
  assert.match(newYear, /Wed/);
  assert.doesNotMatch(newYear, /2024/);
  assert.doesNotMatch(newYear, /Dec/);

  const newYearsEve = formatDate('2025-12-31');
  assert.equal(newYearsEve, shortDate(2025, 11, 31));
  assert.match(newYearsEve, /Wed/);
  assert.doesNotMatch(newYearsEve, /2026/);
  assert.doesNotMatch(newYearsEve, /Jan/);
});

test('formatDate handles a leap day', () => {
  const leapDay = formatDate('2024-02-29'); // a Thursday
  assert.equal(leapDay, shortDate(2024, 1, 29));
  assert.match(leapDay, /Thu/);
  assert.match(leapDay, /\b29\b/);
  assert.match(leapDay, /Feb/);
  assert.match(leapDay, /2024/);
});

test('formatDate formats past dates without depending on the current date', () => {
  // The formatted output is a pure function of the argument, so a fixed historical date
  // stays stable no matter when the suite runs.
  const past = formatDate('1999-12-31'); // a Friday
  assert.equal(past, shortDate(1999, 11, 31));
  assert.match(past, /Fri/);
  assert.match(past, /1999/);
});

test('formatDate returns a placeholder for empty or missing values', () => {
  // Every falsy value is handled by the `if (!s) return '-'` guard, including the
  // non-string falsy ones (which never reach `.split`).
  for (const value of ['', undefined, null, 0, false, NaN]) {
    assert.equal(formatDate(value), '-', `expected ${String(value)} to render the placeholder`);
  }
});

test('formatDate does not throw on a malformed value and flags it as invalid', () => {
  // Callers only pass API-validated YYYY-MM-DD strings, so this path is unreachable in the
  // UI; the assertion documents that garbage input degrades to a visibly invalid value
  // instead of throwing.
  assert.match(formatDate('not-a-date'), /invalid date/i);
  assert.match(formatDate('abc'), /invalid date/i);
});

test('formatDate rolls out-of-range components over instead of rejecting them', () => {
  // Documented quirk: `new Date` normalises its arguments, so a nonsense YYYY-MM-DD is not
  // rejected — it silently renders a different, real day. Also unreachable from the UI
  // (the API validates the format with a strict regex before storing it). Recorded so any
  // future change to this path is deliberate rather than accidental.
  const rolled = formatDate('2025-13-45'); // month 13 + day 45 -> 14 Feb 2026
  assert.equal(rolled, shortDate(2026, 1, 14));
  assert.match(rolled, /2026/);
  assert.match(rolled, /Feb/);
});

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

test('formatTime renders morning times in 12-hour form without a leading zero', () => {
  assert.equal(formatTime('00:00'), '12:00 AM'); // midnight
  assert.equal(formatTime('00:30'), '12:30 AM');
  assert.equal(formatTime('09:05'), '9:05 AM');
  assert.equal(formatTime('11:59'), '11:59 AM');
});

test('formatTime keeps noon and early afternoon on the PM boundary', () => {
  assert.equal(formatTime('12:00'), '12:00 PM'); // noon is 12 PM, not 0 PM
  assert.equal(formatTime('12:45'), '12:45 PM');
});

test('formatTime renders afternoon and evening times in 12-hour form', () => {
  assert.equal(formatTime('13:05'), '1:05 PM');
  assert.equal(formatTime('15:30'), '3:30 PM');
  assert.equal(formatTime('23:59'), '11:59 PM');
});

test('formatTime pads minutes and never pads the hour', () => {
  assert.equal(formatTime('08:00'), '8:00 AM');
  assert.equal(formatTime('08:07'), '8:07 AM');
  assert.equal(formatTime('20:07'), '8:07 PM');
});

test('formatTime returns a placeholder for empty or missing values', () => {
  for (const value of ['', undefined, null, 0, false, NaN]) {
    assert.equal(formatTime(value), '-', `expected ${String(value)} to render the placeholder`);
  }
});

test('formatTime does not guard malformed strings (characterized, not endorsed)', () => {
  // Malformed values are outside the supported contract: the API validates every time with
  // HH:MM before it is stored, and the falsy guard above covers the "missing" case. This
  // test records the current output so any future change is deliberate; it never throws.
  assert.equal(typeof formatTime('not-a-time'), 'string');
  assert.equal(formatTime('not-a-time'), '12:undefined AM');
  assert.equal(formatTime('12'), '12:undefined PM');
});

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

test('getErrorMessage prefers the message from the API response envelope', () => {
  assert.equal(getErrorMessage({ response: { data: { message: 'Invalid email or password' } } }), 'Invalid email or password');
  // Extra envelope fields are ignored.
  assert.equal(getErrorMessage({ response: { data: { success: false, message: 'Doctor not found', data: [] } } }), 'Doctor not found');
});

test('getErrorMessage reports an unreachable backend when there is no response', () => {
  // An axios network/timeout error has `request` but no `response`.
  assert.equal(getErrorMessage({ request: {}, message: 'Network Error' }), 'Cannot reach the server. Is the API running?');
  assert.equal(getErrorMessage({ request: { status: undefined } }), 'Cannot reach the server. Is the API running?');
});

test('getErrorMessage falls back to the error message for plain errors', () => {
  assert.equal(getErrorMessage(new Error('Something broke')), 'Something broke');
  assert.equal(getErrorMessage({ message: 'Unexpected token' }), 'Unexpected token');
});

test('getErrorMessage uses a generic fallback for unknown or empty shapes', () => {
  for (const value of [{}, [], undefined, null, 'boom', 0, false, true]) {
    assert.equal(getErrorMessage(value), 'Something went wrong', `expected a generic message for ${JSON.stringify(value)}`);
  }
});

test('getErrorMessage ignores a response that carries no usable message', () => {
  // An axios error whose server body has no message still exposes axios' own `message`,
  // which is more useful than the generic fallback.
  assert.equal(getErrorMessage({ response: { data: {} }, message: 'Request failed with status code 400' }), 'Request failed with status code 400');
  // An empty string message is falsy, so it falls through as well.
  assert.equal(getErrorMessage({ response: { data: { message: '' } }, message: 'Request failed with status code 500' }), 'Request failed with status code 500');
  // A non-object body cannot provide a message.
  assert.equal(getErrorMessage({ response: { data: 'oops' }, message: 'Request failed with status code 502' }), 'Request failed with status code 502');
});

test('getErrorMessage does not treat a missing response object as an unreachable server', () => {
  assert.equal(getErrorMessage({ response: null, message: 'fallback message' }), 'fallback message');
  assert.equal(getErrorMessage({ response: { data: null } }), 'Something went wrong');
});

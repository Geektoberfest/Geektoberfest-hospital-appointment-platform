const crypto = require('crypto');

/**
 * Short-lived, single-use tickets for the SSE stream.
 *
 * `EventSource` cannot send an `Authorization` header and the refresh cookie is scoped
 * to `/api/auth`, so the browser first exchanges its bearer access token for a ticket
 * over an ordinary authenticated POST and then opens the stream with that ticket in the
 * query string.
 *
 * Because the ticket travels in a URL it is treated as hostile input:
 * - it is 32 random bytes (`base64url`, 43 characters) and is never guessable;
 * - only its SHA-256 hash is kept in memory, so a heap dump or a log of the store
 *   cannot reveal a usable ticket;
 * - it expires after `SSE_TICKET_TTL_MS` (default 30 seconds) and is consumed exactly
 *   once, at connection time;
 * - it authorizes nothing but opening one stream for the user it was issued to.
 *
 * The store is in-process, matching the current single-instance deployment. A
 * multi-instance deployment would need a shared atomic store (the project already ships
 * `ioredis`); see `issue-11-changes.md` for that path.
 */

const DEFAULT_TICKET_TTL_MS = 30000;
const DEFAULT_MAX_TICKETS = 5000;
const TICKET_BYTES = 32;
// base64url of 32 bytes is 43 characters; accept a range to stay forward compatible.
const TICKET_VALUE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/** hash -> { userId, sessionId, expiresAt } */
const tickets = new Map();

const ticketTtlMs = () => {
  const raw = Number(process.env.SSE_TICKET_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_TICKET_TTL_MS;
};

const maxTickets = () => {
  const raw = Number(process.env.SSE_MAX_TICKETS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_MAX_TICKETS;
};

/** Stable, non-reversible lookup key for a raw ticket. */
const hashTicket = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** Drop expired tickets so the store cannot grow without bound. */
const sweepExpired = (now = Date.now()) => {
  let removed = 0;
  for (const [hash, entry] of tickets) {
    if (entry.expiresAt <= now) {
      tickets.delete(hash);
      removed += 1;
    }
  }
  return removed;
};

const normalizeUserId = (userId) => {
  if (!userId) return '';
  if (typeof userId === 'string') return userId.trim();
  if (typeof userId.toHexString === 'function') return userId.toHexString();
  return String(userId);
};

/**
 * Issue a new ticket bound to the authenticated user (and their session).
 * Returns `{ ticket, expiresIn }` where `ticket` is the only time the raw value exists
 * outside the caller's response.
 */
const issueTicket = ({ userId, sessionId } = {}) => {
  const key = normalizeUserId(userId);
  if (!key) return null;

  const now = Date.now();
  sweepExpired(now);

  // A flood of ticket requests before the TTL elapses must not grow the map forever:
  // the oldest tickets are dropped first (Map preserves insertion order).
  const cap = maxTickets();
  while (tickets.size >= cap) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }

  const ttl = ticketTtlMs();
  const raw = crypto.randomBytes(TICKET_BYTES).toString('base64url');
  tickets.set(hashTicket(raw), {
    userId: key,
    sessionId: sessionId ? String(sessionId) : '',
    expiresAt: now + ttl,
  });
  return { ticket: raw, expiresIn: ttl };
};

/**
 * Consume a ticket exactly once and return its claim (`{ userId, sessionId }`).
 *
 * The lookup and the deletion happen in the same synchronous block, so on Node's single
 * event loop a concurrent second request can never observe the entry: one caller wins,
 * every other caller gets `null`. The entry is deleted before the expiry test on
 * purpose — an expired ticket is still burned rather than left reusable.
 *
 * Returns null for anything missing, malformed, unknown, expired or already consumed.
 */
const consumeTicket = (raw) => {
  if (typeof raw !== 'string' || !TICKET_VALUE_RE.test(raw.trim())) return null;
  const hash = hashTicket(raw.trim());
  const entry = tickets.get(hash);
  if (!entry) return null;
  tickets.delete(hash);
  if (entry.expiresAt <= Date.now()) return null;
  return { userId: entry.userId, sessionId: entry.sessionId };
};

/** Number of unexpired-ish tickets currently held (tests and diagnostics). */
const ticketCount = () => tickets.size;

/** Empty the store (tests). */
const clearTickets = () => {
  const size = tickets.size;
  tickets.clear();
  return size;
};

module.exports = {
  DEFAULT_TICKET_TTL_MS,
  DEFAULT_MAX_TICKETS,
  TICKET_VALUE_RE,
  ticketTtlMs,
  hashTicket,
  issueTicket,
  consumeTicket,
  sweepExpired,
  ticketCount,
  clearTickets,
};

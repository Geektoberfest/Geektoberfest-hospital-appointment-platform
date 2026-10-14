'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { addConnection, notifyUser: _notifyUser, connectionCount } = require('../services/notificationService');

/**
 * In-memory store for single-use SSE tickets.
 * ticket (random hex) → { userId, expiresAt }
 *
 * Kept small: each ticket is purged once consumed, and a periodic sweep
 * removes any that were never used (e.g. client crashed before opening the
 * stream).
 */
const tickets = new Map();
const TICKET_TTL_MS = 30_000; // 30 seconds

// Purge expired, unconsumed tickets every 60 s.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of tickets) {
    if (val.expiresAt <= now) tickets.delete(key);
  }
}, 60_000).unref(); // .unref() so this timer never keeps the process alive alone

/**
 * POST /api/notifications/ticket
 * Requires: Bearer access token (protect middleware).
 * Issues a 30-second single-use random ticket for the authenticated user.
 * The ticket is passed as a query param when opening the SSE stream so the
 * Authorization header (which EventSource cannot set) is not needed.
 */
const issueTicket = asyncHandler(async (req, res) => {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { userId: String(req.user._id), expiresAt: Date.now() + TICKET_TTL_MS });
  res.status(200).json({ success: true, message: 'Ticket issued', data: { ticket } });
});

/**
 * GET /api/notifications/stream?ticket=<hex>
 * No Bearer header required – auth is via the one-time ticket above.
 * Opens an SSE stream for the authenticated patient.
 * Sends a heartbeat comment every 25 seconds to keep Render's proxy alive.
 */
const streamSSE = asyncHandler(async (req, res) => {
  const { ticket } = req.query;
  if (!ticket) throw new HttpError(400, 'ticket query parameter is required');

  const entry = tickets.get(ticket);
  if (!entry || entry.expiresAt <= Date.now()) {
    // Consume and reject expired or unknown tickets.
    tickets.delete(ticket);
    throw new HttpError(401, 'Invalid or expired ticket');
  }

  // Single-use: delete immediately after verification.
  const { userId } = entry;
  tickets.delete(ticket);

  // --- SSE headers ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx / Render proxy buffering
  res.flushHeaders();

  // Register connection with the notification service.
  addConnection(userId, res);

  // Send an initial 'connected' event so the client knows the stream is live.
  res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

  // Heartbeat – SSE comments (: ...) keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 25_000);

  // Clean up on disconnect.
  req.on('close', () => clearInterval(heartbeat));
});

/**
 * GET /api/notifications/health  (admin-only diagnostic)
 */
const streamHealth = asyncHandler(async (_req, res) => {
  res.status(200).json({ success: true, data: { connectedUsers: connectionCount() } });
});

module.exports = { issueTicket, streamSSE, streamHealth };

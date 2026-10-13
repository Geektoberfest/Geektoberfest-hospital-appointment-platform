const RefreshToken = require('../models/RefreshToken');
const notifications = require('../services/notificationService');
const { issueTicket, consumeTicket } = require('../utils/sseTickets');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');

/**
 * Notification stream endpoints.
 *
 * Browser `EventSource` cannot set an `Authorization` header, and the refresh cookie is
 * scoped to `/api/auth`, so the stream is authorized with a short-lived single-use
 * ticket:
 *
 *   1. `POST /api/notifications/ticket`  (normal bearer auth) -> `{ ticket, expiresIn }`
 *   2. `GET  /api/notifications/stream?ticket=...`            -> `text/event-stream`
 *
 * The raw access token therefore never appears in a URL. The ticket is returned once,
 * stored only as a hash, expires in ~30 seconds, is burned by its first use, and
 * authorizes nothing except opening one stream for the user it was issued to.
 */

// Sent as the SSE `retry:` field so a browser that reconnects on its own cannot hammer
// the endpoint with an already-spent ticket in the second or two after a drop. The
// frontend closes the connection on error and reconnects with a fresh ticket anyway.
const STREAM_RETRY_HINT_MS = 30000;

// POST /api/notifications/ticket  (authenticated)
const createTicket = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const sessionId = req.sessionId || '';
  if (!userId || !sessionId) {
    throw new HttpError(401, 'Not authenticated: a session is required to open a notification stream');
  }

  let issued = null;
  try {
    issued = issueTicket({ userId, sessionId });
  } catch (err) {
    // Never surface the internal error: it could carry ticket material.
    console.error(`[notifications] ticket issuance failed: ${err?.message || err}`);
  }
  if (!issued?.ticket) {
    throw new HttpError(503, 'Notification tickets are temporarily unavailable');
  }

  res.status(201).json({
    success: true,
    message: 'Notification ticket issued',
    data: { ticket: issued.ticket, expiresIn: issued.expiresIn },
  });
});

// GET /api/notifications/stream?ticket=...  (ticket authentication)
const openStream = asyncHandler(async (req, res) => {
  // Only a single scalar parameter is accepted; anything else (array, object, missing)
  // is rejected before the store is touched.
  const raw = req.query?.ticket;
  const claim = consumeTicket(typeof raw === 'string' ? raw : '');
  if (!claim) {
    throw new HttpError(401, 'Invalid, expired or already used notification ticket');
  }

  // The ticket proves the session existed when it was issued; re-check it so a revoked,
  // expired or deactivated session cannot keep an open stream alive.
  const activeSession = await RefreshToken.exists({
    sessionId: claim.sessionId,
    user: claim.userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!activeSession) {
    throw new HttpError(401, 'Not authenticated: session has been revoked or expired');
  }

  if (notifications.atCapacity()) {
    throw new HttpError(503, 'Too many notification streams are open, please try again shortly');
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx/Render) so frames are delivered immediately.
  res.setHeader('X-Accel-Buffering', 'no');
  // An open stream is expected to stay open; never let a socket idle timeout close it.
  req.socket?.setTimeout?.(0);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = notifications.addClient(claim.userId, res);
  if (!client) {
    res.end();
    return;
  }

  res.write(`retry: ${STREAM_RETRY_HINT_MS}\n\n`);
  res.write(notifications.formatComment('connected'));

  // Exactly one cleanup path per connection, triggered whichever side closes first.
  const cleanup = () => notifications.removeClient(client);
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

module.exports = { createTicket, openStream, STREAM_RETRY_HINT_MS };

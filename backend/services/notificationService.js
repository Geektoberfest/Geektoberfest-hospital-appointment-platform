'use strict';

/**
 * Server-Sent Events (SSE) notification service.
 *
 * Keeps an in-memory map of userId (string) → Set of open SSE response
 * objects.  Works perfectly for a single-process deployment (Render free tier).
 *
 * Multi-instance / horizontal scaling: swap the in-memory map for a Redis
 * pub/sub channel – the project already has ioredis configured in
 * backend/config/redis.js.
 */

/** @type {Map<string, Set<import('express').Response>>} */
const connections = new Map();

/**
 * Register an SSE response object for a user.
 * Automatically removes the connection when the client disconnects.
 *
 * @param {string}                  userId
 * @param {import('express').Response} res
 */
const addConnection = (userId, res) => {
  const id = String(userId);
  if (!connections.has(id)) connections.set(id, new Set());
  connections.get(id).add(res);

  // Clean up when the client closes the connection.
  res.on('close', () => removeConnection(id, res));
};

/**
 * Remove a single SSE connection for a user.
 *
 * @param {string}                  userId
 * @param {import('express').Response} res
 */
const removeConnection = (userId, res) => {
  const id = String(userId);
  const set = connections.get(id);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) connections.delete(id);
};

/**
 * Push an SSE event to all open connections for a user.
 * The call is fire-and-forget – any write error is silently swallowed so
 * that a notification failure can never propagate back to the caller.
 *
 * @param {string} userId
 * @param {string} event  - SSE event name (e.g. 'waitlist.assigned')
 * @param {object} data   - JSON-serialisable payload
 */
const notifyUser = (userId, event, data) => {
  const id = String(userId);
  const set = connections.get(id);
  if (!set || set.size === 0) return; // user has no open tab – that's fine

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of set) {
    try {
      res.write(payload);
      // Flush immediately if the response supports it (e.g. compression middleware).
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      // Client disconnected mid-write; the 'close' handler will clean up.
    }
  }
};

/**
 * Number of currently connected users (useful for health-checks / metrics).
 */
const connectionCount = () => connections.size;

module.exports = { addConnection, removeConnection, notifyUser, connectionCount };

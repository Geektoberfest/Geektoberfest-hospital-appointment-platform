const crypto = require('crypto');

/**
 * Server-Sent Events (SSE) notification service.
 *
 * Keeps an in-memory registry of live patient connections (`userId -> Set<client>`)
 * and lets the rest of the backend push named events to a specific user:
 *
 *     notifications.notifyUser(patientId, 'waitlist.assigned', { appointmentId });
 *
 * Design notes
 * ------------
 * - The current deployment is a single Node process, so an in-process registry is
 *   sufficient. Multiple backend instances would need a shared fan-out (the project
 *   already ships `ioredis`), which is deliberately not added here.
 * - Nothing secret is stored: clients hold only the response object and a user id.
 * - Every operation is failure tolerant. Sending a notification must never be able to
 *   break the business operation that triggered it, so writes are wrapped, dead
 *   connections are pruned, and `notifyUser` always resolves.
 */

const DEFAULT_HEARTBEAT_MS = 25000;
// One patient cannot realistically need more than a handful of open tabs/streams.
const MAX_CONNECTIONS_PER_USER = 10;
// Global guard rail so a connection flood cannot grow the registry without bound.
const MAX_TOTAL_CONNECTIONS = 5000;

/** userId -> Set<client> */
const connections = new Map();

/** Heartbeat interval; `SSE_HEARTBEAT_MS` keeps tests and local troubleshooting fast. */
const heartbeatMs = () => {
  const raw = Number(process.env.SSE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_HEARTBEAT_MS;
};

/** Normalize a user identifier to a stable string key (ObjectId, string or number). */
const normalizeUserId = (userId) => {
  if (!userId) return '';
  if (typeof userId === 'string') return userId.trim();
  if (typeof userId.toHexString === 'function') return userId.toHexString();
  return String(userId);
};

/** A response is still usable until the socket closes or the stream ends. */
const isWritable = (res) =>
  Boolean(res) && res.writableEnded !== true && res.destroyed !== true && res.finished !== true;

/**
 * Write one chunk, tolerating a socket that went away between the check and the write.
 * A failed write is treated exactly like a disconnect.
 */
const writeChunk = (client, chunk) => {
  try {
    if (!isWritable(client.res)) return false;
    client.res.write(chunk);
    return true;
  } catch {
    return false;
  }
};

/** Serialize one SSE frame. `JSON.stringify` escapes newlines, so `data:` stays single-line. */
const formatEvent = (event, data) => `event: ${String(event)}\ndata: ${JSON.stringify(data ?? null)}\n\n`;

/** A comment frame: ignored by `EventSource` listeners, used to keep the socket warm. */
const formatComment = (text = 'ping') => `: ${text}\n\n`;

const totalConnections = () => {
  let total = 0;
  for (const bucket of connections.values()) total += bucket.size;
  return total;
};

/** Number of live connections for one user. */
const userConnectionCount = (userId) => connections.get(normalizeUserId(userId))?.size || 0;

/** Total number of live connections across all users. */
const connectionCount = () => totalConnections();

/** True when a new stream would exceed the global cap. */
const atCapacity = () => totalConnections() >= MAX_TOTAL_CONNECTIONS;

/**
 * Detach a client: stop its heartbeat and drop it from the registry.
 * Idempotent — safe to call from the request close handler, an error handler and an
 * eviction in the same tick.
 */
const removeClient = (client) => {
  if (!client) return false;
  if (client.heartbeatTimer) {
    clearInterval(client.heartbeatTimer);
    client.heartbeatTimer = null;
  }
  const bucket = connections.get(client.userId);
  if (!bucket) return false;
  const removed = bucket.delete(client);
  if (bucket.size === 0) connections.delete(client.userId);
  client.closed = true;
  return removed;
};

/**
 * Register an open SSE response for a user and start its heartbeat.
 *
 * Returns the client handle, or null when the identifier is unusable or the write end
 * is already gone. The oldest connection of a user is evicted once that user reaches
 * `MAX_CONNECTIONS_PER_USER`, which keeps a runaway tab loop from leaking sockets.
 */
const addClient = (userId, res, { heartbeat } = {}) => {
  const key = normalizeUserId(userId);
  if (!key || !isWritable(res)) return null;

  let bucket = connections.get(key);
  if (!bucket) {
    bucket = new Set();
    connections.set(key, bucket);
  }
  while (bucket.size >= MAX_CONNECTIONS_PER_USER) {
    const oldest = bucket.values().next().value;
    if (oldest) {
      writeChunk(oldest, formatComment('replaced'));
      removeClient(oldest);
      try {
        oldest.res.end();
      } catch {
        // The socket was already gone; removal above is what matters.
      }
    } else {
      break;
    }
  }

  const client = {
    id: crypto.randomUUID(),
    userId: key,
    res,
    closed: false,
    createdAt: Date.now(),
    heartbeatTimer: null,
  };
  bucket.add(client);

  if (heartbeat !== false) {
    client.heartbeatTimer = setInterval(() => {
      if (!writeChunk(client, formatComment('ping'))) removeClient(client);
    }, heartbeatMs());
    // Never hold the process open just for heartbeats.
    client.heartbeatTimer.unref?.();
  }

  return client;
};

/**
 * Deliver one named event to a single connection.
 * Returns false when the client is gone (and prunes it).
 */
const sendToClient = (client, event, data) => {
  if (!client || client.closed) return false;
  if (!writeChunk(client, formatEvent(event, data))) {
    removeClient(client);
    return false;
  }
  return true;
};

/**
 * Deliver one named event to every live connection of one user.
 * Returns how many connections received it (0 when the patient is offline).
 * Never throws.
 */
const notifyUser = (userId, event, data) => {
  try {
    const key = normalizeUserId(userId);
    if (!key || !event) return 0;
    const bucket = connections.get(key);
    if (!bucket || bucket.size === 0) return 0;

    // Copy first: a failed write can mutate the registry while we iterate.
    let delivered = 0;
    for (const client of [...bucket]) {
      if (sendToClient(client, event, data)) delivered += 1;
    }
    return delivered;
  } catch (err) {
    console.error(`[notifications] delivery failed for event "${String(event)}": ${err?.message || err}`);
    return 0;
  }
};

/** Drop every connection of one user (used when a session or account is closed). */
const removeUser = (userId) => {
  const key = normalizeUserId(userId);
  const bucket = connections.get(key);
  if (!bucket) return 0;
  let removed = 0;
  for (const client of [...bucket]) {
    if (removeClient(client)) removed += 1;
    try {
      client.res.end();
    } catch {
      // Already closed.
    }
  }
  connections.delete(key);
  return removed;
};

/** Close everything (tests and graceful shutdown). */
const closeAll = () => {
  const removed = totalConnections();
  for (const userId of [...connections.keys()]) removeUser(userId);
  connections.clear();
  return removed;
};

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  MAX_CONNECTIONS_PER_USER,
  MAX_TOTAL_CONNECTIONS,
  heartbeatMs,
  formatEvent,
  formatComment,
  atCapacity,
  addClient,
  removeClient,
  sendToClient,
  notifyUser,
  removeUser,
  userConnectionCount,
  connectionCount,
  closeAll,
};

/**
 * Browser-side client for the waiting-list Server-Sent Events stream.
 *
 * Kept free of axios and React so the connection lifecycle can be unit tested directly
 * (see frontend/tests/notificationStream.test.js), mirroring `authSession.js`.
 *
 * Why the connection is managed here instead of relying on `EventSource`:
 * the stream is authorized with a single-use ticket, so the browser's automatic
 * reconnect (which replays the same URL) can never succeed. Any error therefore closes
 * the connection and re-opens it with a fresh ticket after a bounded backoff.
 */

export const ASSIGNED_EVENT = 'waitlist.assigned';

/** Reconnect delays in milliseconds; the last entry is the ceiling (no unbounded growth). */
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 10000, 20000, 30000];

/** How many notifications the UI keeps at once. */
export const MAX_TRACKED_NOTIFICATIONS = 20;

/** Bounded, monotonically non-decreasing reconnect delay for attempt 1..n. */
export const nextBackoffMs = (attempt) => {
  const index = Math.min(Math.max(Math.floor(Number(attempt) || 1), 1), BACKOFF_SCHEDULE_MS.length);
  return BACKOFF_SCHEDULE_MS[index - 1];
};

/** Build the absolute stream URL for a ticket. The ticket is always URL-encoded. */
export const streamUrl = (baseUrl, ticket) =>
  `${String(baseUrl || '').replace(/\/+$/, '')}/notifications/stream?ticket=${encodeURIComponent(String(ticket || ''))}`;

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Parse a `waitlist.assigned` frame defensively.
 *
 * Returns null for anything that is not a usable assignment, so malformed or unexpected
 * data can never reach the UI. Only booking facts are copied across; unknown and
 * sensitive fields in the frame are ignored.
 */
export const parseAssignment = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const appointmentId = asText(payload.appointmentId);
  if (!appointmentId) return null; // nothing actionable to show or link to

  return {
    appointmentId,
    waitingListEntryId: asText(payload.waitingListEntryId),
    date: asText(payload.date),
    startTime: asText(payload.startTime),
    endTime: asText(payload.endTime),
    doctorName: asText(payload.doctorName),
    specialization: asText(payload.specialization),
    status: asText(payload.status) || 'booked',
  };
};

/**
 * Insert a notification at the front of the list, replacing any earlier notification for
 * the same appointment. This is what makes a reconnect (which can legitimately re-deliver
 * a recent assignment) or a React remount idempotent, and it keeps the list bounded.
 */
export const mergeNotification = (list, notification, max = MAX_TRACKED_NOTIFICATIONS) => {
  if (!notification?.appointmentId) return list || [];
  const others = (list || []).filter((item) => item.appointmentId !== notification.appointmentId);
  return [notification, ...others].slice(0, Math.max(1, max));
};

/**
 * Manage one SSE connection.
 *
 * @param {object} options
 * @param {() => Promise<string>} options.requestTicket  authenticated ticket request
 * @param {(ticket: string) => EventSource} options.createEventSource factory (injectable for tests)
 * @param {(notification: object) => void} options.onNotification called with parsed assignments
 * @param {(status: object) => void} [options.onStatus]   'connecting' | 'connected' | 'reconnecting'
 * @param {(err: unknown) => void} [options.onError]      never throws out of the manager
 * @param {Function} [options.setTimeout] / [options.clearTimeout] injectable timers
 */
export function createNotificationStream({
  requestTicket,
  createEventSource,
  onNotification,
  onStatus,
  onError,
  setTimeout: schedule = setTimeout,
  clearTimeout: unschedule = clearTimeout,
} = {}) {
  let source = null;
  let retryTimer = null;
  let stopped = true;
  let attempt = 0;
  let generation = 0;

  const emitStatus = (state, extra = {}) => {
    if (onStatus) onStatus({ state, attempt, ...extra });
  };

  const clearRetry = () => {
    if (retryTimer !== null) {
      unschedule(retryTimer);
      retryTimer = null;
    }
  };

  const teardown = () => {
    if (!source) return;
    try {
      source.close();
    } catch {
      // A half-open EventSource can throw on close; nothing else to do.
    }
    source = null;
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer !== null) return;
    attempt += 1;
    const delay = nextBackoffMs(attempt);
    emitStatus('reconnecting', { delay });
    const generationAtSchedule = generation;

    retryTimer = schedule(() => {
      retryTimer = null;
      if (stopped || generationAtSchedule !== generation) return;
      open();
    }, delay);
  };

  /** Request a fresh ticket and (re)open the stream. Never throws. */
  const open = async () => {
    if (stopped) return;
    const generationAtStart = generation;

    teardown(); // never keep two connections alive at once
    emitStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    let ticket;
    try {
      ticket = await requestTicket();
    } catch (err) {
      if (onError) onError(err);
      if (stopped || generationAtStart !== generation) return;
      // The backend is unavailable or the session is gone: retry on the backoff schedule
      // instead of looping with no delay.
      scheduleReconnect();
      return;
    }

    // The component may have unmounted (or the user logged out) while the ticket was in
    // flight: drop the now-useless single-use ticket rather than opening a stream.
    if (stopped || generationAtStart !== generation) return;
    if (typeof ticket !== 'string' || !ticket) {
      if (onError) onError(new Error('Notification stream ticket was empty'));
      scheduleReconnect();
      return;
    }

    let eventSource;
    try {
      eventSource = createEventSource(ticket);
    } catch (err) {
      if (onError) onError(err);
      scheduleReconnect();
      return;
    }
    source = eventSource;

    eventSource.addEventListener('open', () => {
      if (stopped || source !== eventSource) return;
      attempt = 0; // a healthy connection resets the backoff
      emitStatus('connected');
    });

    eventSource.addEventListener(ASSIGNED_EVENT, (event) => {
      if (stopped || source !== eventSource) return;
      const notification = parseAssignment(event?.data);
      if (!notification) {
        if (onError) onError(new Error('Ignored a malformed waitlist.assigned payload'));
        return;
      }
      if (onNotification) onNotification(notification);
    });

    eventSource.addEventListener('error', () => {
      if (stopped || source !== eventSource) return;
      // The ticket is spent and browser auto-reconnect would replay it, so close now and
      // come back with a new one.
      teardown();
      if (onError) onError(new Error('Notification stream disconnected'));
      scheduleReconnect();
    });
  };

  return {
    /** Open the stream. Idempotent: a second call while running is ignored. */
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      open();
    },
    /** Close the stream and cancel every pending retry. Safe to call repeatedly. */
    stop() {
      stopped = true;
      generation += 1;
      clearRetry();
      teardown();
      attempt = 0;
      emitStatus('stopped');
    },
    isRunning: () => !stopped,
    currentAttempt: () => attempt,
  };
}

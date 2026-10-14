import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { issueTicket } from '../api/notificationApi';
import { normalizeApiUrl } from '../api/axios';

export const NotificationContext = createContext(null);

/**
 * Derives the bare SSE base URL (without the /api suffix) from the same
 * environment variable used by the Axios instance.
 */
const SSE_BASE = normalizeApiUrl(import.meta.env?.VITE_API_URL)
  .replace(/\/api$/, '/api'); // keep /api – we want /api/notifications/stream

/**
 * NotificationProvider
 * – Only activates the SSE stream when `user` is a patient.
 * – Obtains a fresh single-use ticket, then opens EventSource.
 * – On stream error: closes the broken source, waits RECONNECT_DELAY_MS,
 *   then fetches a new ticket and reconnects (because the old ticket is spent).
 * – Exposes { notifications, clearNotification, clearAll } to consumers.
 */
const RECONNECT_DELAY_MS = 5_000;
const MAX_NOTIFICATIONS = 50; // cap to avoid unbounded growth

export function NotificationProvider({ user, children }) {
  const [notifications, setNotifications] = useState([]);
  const esRef = useRef(null);         // current EventSource
  const reconnectTimer = useRef(null); // pending reconnect setTimeout id
  const mountedRef = useRef(true);

  // ---------- helpers ----------

  const addNotification = useCallback((event, data) => {
    setNotifications((prev) => {
      const next = [
        { id: Date.now() + Math.random(), event, data, timestamp: new Date().toISOString() },
        ...prev,
      ];
      return next.slice(0, MAX_NOTIFICATIONS);
    });
  }, []);

  const clearNotification = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);

  // ---------- SSE lifecycle ----------

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  const openStream = useCallback(async () => {
    if (!mountedRef.current) return;
    closeStream();

    let ticket;
    try {
      ticket = await issueTicket();
    } catch (err) {
      // Not authenticated yet or server error – schedule a retry.
      if (mountedRef.current) {
        reconnectTimer.current = setTimeout(openStream, RECONNECT_DELAY_MS);
      }
      return;
    }

    if (!mountedRef.current) return;

    const url = `${SSE_BASE}/notifications/stream?ticket=${encodeURIComponent(ticket)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('connected', () => {
      // Stream is live – nothing extra to do; the server already confirmed auth.
    });

    es.addEventListener('waitlist.assigned', (e) => {
      try {
        const data = JSON.parse(e.data);
        addNotification('waitlist.assigned', data);
      } catch (_) {
        // Malformed payload – ignore.
      }
    });

    es.onerror = () => {
      // EventSource fires onerror on any disconnect or HTTP error.
      // We close and reconnect with a fresh ticket (old ticket is spent).
      closeStream();
      if (mountedRef.current) {
        reconnectTimer.current = setTimeout(openStream, RECONNECT_DELAY_MS);
      }
    };
  }, [addNotification, closeStream]);

  // Open the stream only for patients; close it when role changes or unmounts.
  useEffect(() => {
    mountedRef.current = true;

    if (user?.role === 'patient') {
      openStream();
    } else {
      closeStream();
    }

    return () => {
      mountedRef.current = false;
      closeStream();
    };
  }, [user?.role, user?._id, openStream, closeStream]);

  return (
    <NotificationContext.Provider value={{ notifications, clearNotification, clearAll }}>
      {children}
    </NotificationContext.Provider>
  );
}

/** Convenience hook – throws if used outside NotificationProvider. */
export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationProvider');
  return ctx;
}

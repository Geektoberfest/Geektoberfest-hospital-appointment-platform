import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import * as notificationApi from '../api/notificationApi';
import { createNotificationStream, mergeNotification } from '../api/notificationStream';
import useAuth from '../hooks/useAuth';

export const NotificationContext = createContext(null);

/**
 * Keeps one Server-Sent Events connection open for the signed-in patient and collects
 * waiting-list reassignment notices.
 *
 * The stream is only opened once the session is established (never for anonymous visitors
 * or for the doctor/admin roles) and it is closed on logout and on unmount. Because the
 * connection is authorized with a single-use ticket, the manager reconnects with a fresh
 * ticket and a bounded backoff whenever the stream drops.
 */
export function NotificationProvider({ children }) {
  const { user, loading } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [status, setStatus] = useState('idle');

  const isPatient = Boolean(user) && user.role === 'patient';

  useEffect(() => {
    // `typeof EventSource` guards browsers/environments without SSE support.
    if (loading || !isPatient || typeof EventSource === 'undefined') return undefined;

    const stream = createNotificationStream({
      requestTicket: notificationApi.requestTicket,
      // A fresh EventSource per attempt: the previous ticket is always spent.
      createEventSource: (ticket) => new EventSource(notificationApi.buildStreamUrl(ticket)),
      onNotification: (notification) => setNotifications((prev) => mergeNotification(prev, notification)),
      onStatus: ({ state }) => setStatus(state),
    });

    stream.start();
    // React StrictMode mounts effects twice in development; stop() closes the first
    // connection and cancels its retries, so exactly one stream stays open.
    return () => stream.stop();
  }, [loading, isPatient]);

  // Signing out (or switching account) empties the queue so one patient never sees
  // another patient's notifications.
  useEffect(() => {
    if (!isPatient) setNotifications([]);
  }, [isPatient]);

  const dismiss = useCallback((appointmentId) => {
    setNotifications((prev) => prev.filter((item) => item.appointmentId !== appointmentId));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  const value = useMemo(
    () => ({
      notifications,
      status,
      connected: status === 'connected',
      dismiss,
      clear,
    }),
    [notifications, status, dismiss, clear]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

import { useEffect, useState } from 'react';
import { useNotifications } from '../../context/NotificationContext';

/**
 * NotificationBanner
 *
 * Renders a stack of dismissable toast banners at the top-right corner of the
 * viewport for every unread notification. Currently handles:
 *
 *  - waitlist.assigned  → teal "appointment assigned" banner
 *
 * The component is intentionally kept dependency-free (no external toast
 * library) so it works with any version of the project.
 */

const EVENT_CONFIG = {
  'waitlist.assigned': {
    icon: '🎉',
    title: 'Slot Assigned!',
    color: 'bg-teal-600',
  },
};

function Toast({ notification, onDismiss }) {
  const [visible, setVisible] = useState(false);

  // Fade-in on mount.
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Auto-dismiss after 8 seconds.
  useEffect(() => {
    const t = setTimeout(() => onDismiss(notification.id), 8_000);
    return () => clearTimeout(t);
  }, [notification.id, onDismiss]);

  const cfg = EVENT_CONFIG[notification.event] || {
    icon: '🔔',
    title: 'Notification',
    color: 'bg-slate-700',
  };

  const { data } = notification;

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{ transition: 'opacity 0.3s, transform 0.3s' }}
      className={`w-80 rounded-lg shadow-lg text-white text-sm overflow-hidden ${cfg.color} ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <span className="text-xl leading-none">{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold">{cfg.title}</p>
          {data?.message && <p className="mt-0.5 opacity-90">{data.message}</p>}
          {data?.doctor && (
            <p className="mt-1 opacity-80 text-xs">
              Dr. {data.doctor} · {data.date} {data.startTime && `@ ${data.startTime}`}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(notification.id)}
          className="shrink-0 opacity-70 hover:opacity-100 transition text-lg leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default function NotificationBanner() {
  const { notifications, clearNotification } = useNotifications();

  if (!notifications.length) return null;

  return (
    <div
      aria-label="Notifications"
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      {notifications.map((n) => (
        <div key={n.id} className="pointer-events-auto">
          <Toast notification={n} onDismiss={clearNotification} />
        </div>
      ))}
    </div>
  );
}

import { Link } from 'react-router-dom';
import useNotifications from '../../hooks/useNotifications';
import { formatDate, formatTime } from '../../utils/format';

/**
 * Live banner for waiting-list reassignments pushed over SSE.
 *
 * Rendered inside the authenticated layout, so it survives route changes without
 * remounting the stream (the provider sits above the router outlet).
 */
export default function NotificationBanner() {
  const { notifications, dismiss, clear } = useNotifications();
  if (!notifications.length) return null;

  return (
    <div className="mb-4 space-y-2" role="status" aria-live="polite" aria-label="Waiting list notifications">
      {notifications.map((n) => (
        <div
          key={n.appointmentId}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          <div>
            <p className="font-medium">
              {n.doctorName ? `A cancelled slot with Dr. ${n.doctorName} was assigned to you` : 'A cancelled slot was assigned to you'}
            </p>
            <p className="text-emerald-700">
              {formatDate(n.date)} at {formatTime(n.startTime)}
              {n.endTime ? ` - ${formatTime(n.endTime)}` : ''}
              {n.specialization ? ` · ${n.specialization}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="btn-secondary btn-sm" to={`/patient/appointments/${n.appointmentId}`}>
              View appointment
            </Link>
            <button type="button" className="btn-secondary btn-sm" onClick={() => dismiss(n.appointmentId)} aria-label="Dismiss this notification">
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {notifications.length > 1 && (
        <button type="button" className="btn-secondary btn-sm" onClick={clear}>
          Dismiss all
        </button>
      )}
    </div>
  );
}

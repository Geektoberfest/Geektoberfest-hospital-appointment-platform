import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as sessionApi from '../api/sessionApi';
import DataTable from '../components/admin/DataTable';
import Alert from '../components/common/Alert';
import PageHeader from '../components/common/PageHeader';
import Spinner from '../components/common/Spinner';
import useAuth from '../hooks/useAuth';
import useFetch from '../hooks/useFetch';
import { getErrorMessage } from '../utils/format';

const formatTimestamp = (value) => (value ? new Date(value).toLocaleString() : '-');

/** Active devices for the signed-in user, with per-device and global revocation. */
export default function Sessions() {
  const { data, loading, error, reload } = useFetch(() => sessionApi.listSessions());
  const { clearSession } = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState({ type: '', text: '' });
  const [busy, setBusy] = useState(false);

  const sessions = data || [];

  const revokeOne = async (session) => {
    const prompt = session.current ? 'Sign out of this device?' : `Revoke the session on ${session.device}?`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    try {
      await sessionApi.revokeSession(session._id);
      if (session.current) {
        clearSession();
        navigate('/login');
        return;
      }
      setMessage({ type: 'success', text: 'Session revoked' });
      reload();
    } catch (err) {
      setMessage({ type: 'error', text: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    if (!window.confirm('Sign out of all devices? You will need to sign in again.')) return;
    setBusy(true);
    try {
      await sessionApi.revokeAllSessions();
      clearSession();
      navigate('/login');
    } catch (err) {
      setMessage({ type: 'error', text: getErrorMessage(err) });
      setBusy(false);
    }
  };

  const columns = [
    {
      header: 'Device',
      render: (s) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{s.device}</span>
          {s.current && (
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800">This device</span>
          )}
        </div>
      ),
    },
    { header: 'IP address', render: (s) => s.ip || '-' },
    { header: 'Signed in', render: (s) => formatTimestamp(s.startedAt) },
    { header: 'Last refreshed', render: (s) => formatTimestamp(s.lastRefreshedAt) },
    { header: 'Expires', render: (s) => formatTimestamp(s.expiresAt) },
    {
      header: 'Actions',
      render: (s) => (
        <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={() => revokeOne(s)}>
          {s.current ? 'Sign out' : 'Revoke'}
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Active sessions"
        subtitle="Devices currently signed in to your account. Revoking a device signs it out immediately."
        actions={
          <button type="button" id="revoke-all-sessions" className="btn-secondary" disabled={busy || loading} onClick={revokeAll}>
            Sign out of all devices
          </button>
        }
      />
      <div className="mb-4 space-y-2">
        <Alert type={message.type || 'info'}>{message.text}</Alert>
        <Alert>{error}</Alert>
      </div>
      {loading ? <Spinner label="Loading sessions..." /> : <DataTable columns={columns} rows={sessions} emptyTitle="No active sessions" />}
    </div>
  );
}

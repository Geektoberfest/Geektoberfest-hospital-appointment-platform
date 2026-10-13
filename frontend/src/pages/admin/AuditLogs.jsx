import { useEffect, useState } from 'react';
import * as adminApi from '../../api/adminApi';
import DataTable from '../../components/admin/DataTable';
import Alert from '../../components/common/Alert';
import PageHeader from '../../components/common/PageHeader';
import Spinner from '../../components/common/Spinner';
import useFetch from '../../hooks/useFetch';

const LIMIT = 25;

const OUTCOMES = [
  ['', 'All outcomes'],
  ['success', 'Success'],
  ['failure', 'Failure'],
  ['denied', 'Denied'],
  ['error', 'Error'],
];

const OUTCOME_STYLES = {
  success: 'bg-emerald-100 text-emerald-700',
  failure: 'bg-red-100 text-red-700',
  denied: 'bg-amber-100 text-amber-800',
  error: 'bg-slate-200 text-slate-700',
};

const formatTimestamp = (value) => (value ? new Date(value).toLocaleString() : '-');

const shortId = (id) => (id ? String(id).slice(-6) : '');

/**
 * Admin-only audit trail. The endpoint is guarded server-side by
 * `protect` + `authorize('admin')`; this page is a convenience on top of it.
 */
export default function AuditLogs() {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [debounced, setDebounced] = useState({ action: '', search: '' });

  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ action: action.trim(), search: search.trim() }), 300);
    return () => clearTimeout(timer);
  }, [action, search]);

  // Any filter change must restart pagination, otherwise the admin sees an empty page.
  useEffect(() => {
    setPage(1);
  }, [debounced.action, debounced.search, outcome]);

  const { data, loading, error } = useFetch(() => {
    const params = { page, limit: LIMIT };
    if (debounced.action) params.action = debounced.action;
    if (debounced.search) params.search = debounced.search;
    if (outcome) params.outcome = outcome;
    return adminApi.getAuditLogs(params);
  }, [page, debounced.action, debounced.search, outcome]);

  const logs = data?.logs || [];
  const pagination = data?.pagination || { page: 1, pages: 1, total: 0 };

  const columns = [
    { header: 'Time', render: (log) => formatTimestamp(log.createdAt) },
    { header: 'Action', render: (log) => <span className="font-mono text-xs font-medium">{log.action}</span> },
    {
      header: 'Outcome',
      render: (log) => (
        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${OUTCOME_STYLES[log.outcome] || 'bg-slate-100 text-slate-600'}`}>
          {log.outcome}
        </span>
      ),
    },
    {
      header: 'Actor',
      render: (log) => (log.actor ? `${log.actorRole || 'user'} · ${shortId(log.actor)}` : 'anonymous'),
    },
    {
      header: 'Target',
      render: (log) =>
        log.targetType ? `${log.targetType} · ${shortId(log.targetId || log.targetUser)}` : '-',
    },
    { header: 'Request', render: (log) => (log.method ? `${log.method} ${log.path}` : '-') },
    { header: 'IP', render: (log) => log.ip || '-' },
    {
      header: 'Details',
      render: (log) => (
        <span className="block max-w-xs truncate" title={log.description}>
          {log.description || '-'}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Audit logs"
        subtitle="Security-relevant events: RBAC denials, session changes, admin actions, and token reuse."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="audit-action" className="label">Action</label>
          <input
            id="audit-action"
            className="input"
            placeholder="e.g. auth.refresh.reuse_detected"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="audit-outcome" className="label">Outcome</label>
          <select id="audit-outcome" className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {OUTCOMES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-search" className="label">Search details</label>
          <input
            id="audit-search"
            className="input"
            placeholder="Description text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="mb-4">
        <Alert>{error}</Alert>
      </div>

      {loading ? (
        <Spinner label="Loading audit logs..." />
      ) : (
        <>
          <DataTable columns={columns} rows={logs} emptyTitle="No audit records match these filters" />
          <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
            <span>
              Page {pagination.page} of {pagination.pages} · {pagination.total} record{pagination.total === 1 ? '' : 's'}
            </span>
            <div className="flex gap-2">
              <button type="button" id="audit-prev" className="btn-secondary btn-sm" disabled={pagination.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </button>
              <button type="button" id="audit-next" className="btn-secondary btn-sm" disabled={pagination.page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

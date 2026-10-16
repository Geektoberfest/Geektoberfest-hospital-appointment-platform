import { useState } from 'react';
import * as availabilityApi from '../../api/availabilityApi';
import DataTable from '../../components/admin/DataTable';
import Alert from '../../components/common/Alert';
import FormField from '../../components/common/FormField';
import PageHeader from '../../components/common/PageHeader';
import Spinner from '../../components/common/Spinner';
import useFetch from '../../hooks/useFetch';
import { formatDate, formatTime, getErrorMessage, todayString } from '../../utils/format';
import { validateAvailability } from '../../utils/validation';

const DAYS = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

const emptyForm = {
  isRecurring: false,
  date: '',
  daysOfWeek: [1, 2, 3, 4, 5],
  startDate: '',
  endDate: '',
  startTime: '09:00',
  endTime: '17:00',
  slotDuration: 30,
  breaks: [],
};

export default function AvailabilityManagement() {
  const { data, loading, error, reload } = useFetch(() => availabilityApi.getMyAvailability({ from: todayString() }));
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState({ type: '', text: '' });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const reset = () => {
    setForm(emptyForm);
    setEditingId(null);
    setErrors({});
  };

  const toggleDay = (dayVal) => {
    const current = form.daysOfWeek || [];
    const updated = current.includes(dayVal)
      ? current.filter((d) => d !== dayVal)
      : [...current, dayVal].sort((a, b) => a - b);
    setForm({ ...form, daysOfWeek: updated });
  };

  const addBreak = () => {
    setForm({
      ...form,
      breaks: [...(form.breaks || []), { label: 'Lunch', startTime: '13:00', endTime: '14:00' }],
    });
  };

  const updateBreak = (idx, field, value) => {
    const breaks = [...(form.breaks || [])];
    breaks[idx] = { ...breaks[idx], [field]: value };
    setForm({ ...form, breaks });
  };

  const removeBreak = (idx) => {
    const breaks = (form.breaks || []).filter((_, i) => i !== idx);
    setForm({ ...form, breaks });
  };

  const submit = async (e) => {
    e.preventDefault();
    setMessage({ type: '', text: '' });
    const errs = validateAvailability(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const payload = {
      isRecurring: form.isRecurring,
      startTime: form.startTime,
      endTime: form.endTime,
      slotDuration: Number(form.slotDuration),
      breaks: form.breaks || [],
      ...(form.isRecurring
        ? {
            daysOfWeek: form.daysOfWeek,
            startDate: form.startDate || '',
            endDate: form.endDate || '',
            date: '',
          }
        : {
            date: form.date,
            daysOfWeek: [],
          }),
    };

    setBusy(true);
    try {
      if (editingId) await availabilityApi.updateAvailability(editingId, payload);
      else await availabilityApi.createAvailability(payload);
      setMessage({ type: 'success', text: editingId ? 'Availability updated' : 'Availability added' });
      reset();
      reload();
    } catch (err) {
      setMessage({ type: 'error', text: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a) => {
    const desc = a.isRecurring ? 'this recurring schedule' : `availability on ${formatDate(a.date)}`;
    if (!window.confirm(`Remove ${desc}?`)) return;
    try {
      await availabilityApi.removeAvailability(a._id);
      setMessage({ type: 'success', text: 'Availability removed' });
      reload();
    } catch (err) {
      setMessage({ type: 'error', text: getErrorMessage(err) });
    }
  };

  const edit = (a) => {
    setEditingId(a._id);
    setForm({
      isRecurring: Boolean(a.isRecurring),
      date: a.date || '',
      daysOfWeek: a.daysOfWeek && a.daysOfWeek.length ? a.daysOfWeek : [1, 2, 3, 4, 5],
      startDate: a.startDate || '',
      endDate: a.endDate || '',
      startTime: a.startTime,
      endTime: a.endTime,
      slotDuration: a.slotDuration,
      breaks: a.breaks || [],
    });
    setErrors({});
  };

  const formatDays = (days = []) => {
    if (!days || !days.length) return 'None';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days.map((d) => dayNames[d]).join(', ');
  };

  const columns = [
    {
      header: 'Type / Schedule',
      render: (a) =>
        a.isRecurring ? (
          <div>
            <span className="inline-flex items-center rounded bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
              Weekly Recurring
            </span>
            <div className="mt-1 text-sm font-medium text-slate-800">{formatDays(a.daysOfWeek)}</div>
            {(a.startDate || a.endDate) && (
              <div className="text-xs text-slate-500">
                {a.startDate || 'Start'} to {a.endDate || 'End'}
              </div>
            )}
          </div>
        ) : (
          <div>
            <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              Specific Date
            </span>
            <div className="mt-1 text-sm font-medium text-slate-800">{formatDate(a.date)}</div>
          </div>
        ),
    },
    { header: 'Window', render: (a) => `${formatTime(a.startTime)} - ${formatTime(a.endTime)}` },
    {
      header: 'Break Exclusions',
      render: (a) =>
        a.breaks?.length ? (
          <div className="space-y-1">
            {a.breaks.map((b, i) => (
              <span key={i} className="inline-block rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800 mr-1">
                {b.label || 'Break'}: {formatTime(b.startTime)}–{formatTime(b.endTime)}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-400">None</span>
        ),
    },
    { header: 'Slot length', render: (a) => `${a.slotDuration} min` },
    {
      header: 'Actions',
      render: (a) => (
        <div className="flex gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => edit(a)}>
            Edit
          </button>
          <button type="button" className="btn-danger btn-sm" onClick={() => remove(a)}>
            Remove
          </button>
        </div>
      ),
    },
  ];
  const cls = (k) => `input ${errors[k] ? 'input-error' : ''}`;

  return (
    <div>
      <PageHeader title="Availability" subtitle="Publish weekly recurring or single-date windows with break exclusions" />
      <form onSubmit={submit} className="card mb-6 space-y-4" noValidate id="availability-form">
        <div className="flex items-center gap-6 border-b border-slate-200 pb-3">
          <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-slate-700">
            <input
              type="radio"
              name="mode"
              checked={!form.isRecurring}
              onChange={() => setForm({ ...form, isRecurring: false })}
              className="text-brand-600 focus:ring-brand-500"
            />
            Specific Date
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-slate-700">
            <input
              type="radio"
              name="mode"
              checked={form.isRecurring}
              onChange={() => setForm({ ...form, isRecurring: true })}
              className="text-brand-600 focus:ring-brand-500"
            />
            Weekly Recurring Schedule
          </label>
        </div>

        {form.isRecurring ? (
          <div className="space-y-3">
            <div>
              <label className="label">Days of Week</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {DAYS.map((d) => {
                  const selected = form.daysOfWeek?.includes(d.value);
                  return (
                    <button
                      type="button"
                      key={d.value}
                      onClick={() => toggleDay(d.value)}
                      className={`px-3 py-1 text-xs font-semibold rounded-md transition ${
                        selected
                          ? 'bg-brand-600 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
              {errors.daysOfWeek && <p className="mt-1 text-xs text-rose-600">{errors.daysOfWeek}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Start Date (Optional)" id="a-sdate" error={errors.startDate}>
                <input
                  id="a-sdate"
                  type="date"
                  className={cls('startDate')}
                  value={form.startDate}
                  onChange={set('startDate')}
                />
              </FormField>
              <FormField label="End Date (Optional)" id="a-edate" error={errors.endDate}>
                <input
                  id="a-edate"
                  type="date"
                  className={cls('endDate')}
                  value={form.endDate}
                  onChange={set('endDate')}
                />
              </FormField>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Date" id="a-date" error={errors.date}>
              <input
                id="a-date"
                type="date"
                min={todayString()}
                className={cls('date')}
                value={form.date}
                onChange={set('date')}
              />
            </FormField>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Start time" id="a-start" error={errors.startTime}>
            <input id="a-start" type="time" className={cls('startTime')} value={form.startTime} onChange={set('startTime')} />
          </FormField>
          <FormField label="End time" id="a-end" error={errors.endTime}>
            <input id="a-end" type="time" className={cls('endTime')} value={form.endTime} onChange={set('endTime')} />
          </FormField>
          <FormField label="Slot (minutes)" id="a-dur" error={errors.slotDuration}>
            <input
              id="a-dur"
              type="number"
              min="10"
              max="120"
              step="5"
              className={cls('slotDuration')}
              value={form.slotDuration}
              onChange={set('slotDuration')}
            />
          </FormField>
        </div>

        {/* Break Exclusions */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">Break Exclusions (e.g. Lunch)</span>
            <button type="button" onClick={addBreak} className="btn-secondary btn-sm">
              + Add Break
            </button>
          </div>
          {errors.breaks && <p className="text-xs text-rose-600">{errors.breaks}</p>}
          {form.breaks?.length === 0 ? (
            <p className="text-xs text-slate-500">No break exclusions added for this window.</p>
          ) : (
            <div className="space-y-2">
              {form.breaks.map((b, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 bg-white p-2 rounded border border-slate-200">
                  <input
                    type="text"
                    placeholder="Break Label (e.g. Lunch)"
                    value={b.label || ''}
                    onChange={(e) => updateBreak(idx, 'label', e.target.value)}
                    className="input input-sm w-36"
                  />
                  <div className="flex items-center gap-1 text-xs text-slate-600">
                    <span>From</span>
                    <input
                      type="time"
                      value={b.startTime || ''}
                      onChange={(e) => updateBreak(idx, 'startTime', e.target.value)}
                      className="input input-sm"
                    />
                    <span>to</span>
                    <input
                      type="time"
                      value={b.endTime || ''}
                      onChange={(e) => updateBreak(idx, 'endTime', e.target.value)}
                      className="input input-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeBreak(idx)}
                    className="btn-danger btn-sm ml-auto"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button type="submit" id="save-availability" className="btn-primary" disabled={busy}>
            {editingId ? 'Update' : 'Add window'}
          </button>
          {editingId && (
            <button type="button" className="btn-secondary" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="mb-4 space-y-2">
        <Alert type={message.type || 'info'}>{message.text}</Alert>
        <Alert>{error}</Alert>
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={data || []}
          emptyTitle="No upcoming availability"
          emptyMessage="Add a window above so patients can book."
        />
      )}
    </div>
  );
}

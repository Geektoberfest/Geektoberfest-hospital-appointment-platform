import { Link } from 'react-router-dom';
import * as appointmentApi from '../../api/appointmentApi';
import * as waitingListApi from '../../api/waitingListApi';
import StatCard from '../../components/admin/StatCard';
import AppointmentList from '../../components/appointments/AppointmentList';
import Alert from '../../components/common/Alert';
import PageHeader from '../../components/common/PageHeader';
import { SkeletonStatGrid, SkeletonTable } from '../../components/common/Skeleton';
import useAuth from '../../hooks/useAuth';
import useFetch from '../../hooks/useFetch';
import { todayString } from '../../utils/format';

export default function PatientDashboard() {
  const { user } = useAuth();
  const appts = useFetch(() => appointmentApi.getMyAppointments());
  const waiting = useFetch(() => waitingListApi.getMyWaitingList());

  // The header depends only on the signed-in user, so the loading and loaded states share
  // it: showing the real header while data loads avoids a layout jump.
  const header = (
    <PageHeader
      title={`Hello, ${user.name.split(' ')[0]}`}
      subtitle="Here is an overview of your care"
      actions={<Link to="/patient/doctors" className="btn-primary" id="find-doctor">Find a doctor</Link>}
    />
  );

  // While either request is in flight, mirror the loaded dashboard: the four stat cards,
  // then the upcoming appointments table. The status region announces the state once.
  if (appts.loading || waiting.loading) {
    return (
      <div>
        {header}
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading dashboard…</span>
          <SkeletonStatGrid count={4} />
          <h2 className="mb-3 text-lg font-semibold">Upcoming appointments</h2>
          <SkeletonTable rows={5} columns={5} />
        </div>
      </div>
    );
  }

  const all = appts.data || [];
  const today = todayString();
  const upcoming = all.filter((a) => a.status === 'booked' && a.date >= today).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  return (
    <div>
      {header}
      <Alert>{appts.error || waiting.error}</Alert>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Upcoming" value={upcoming.length} tone="sky" />
        <StatCard label="Completed" value={all.filter((a) => a.status === 'completed').length} tone="emerald" />
        <StatCard label="Cancelled" value={all.filter((a) => a.status === 'cancelled').length} tone="slate" />
        <StatCard label="On waiting list" value={(waiting.data || []).filter((w) => w.status === 'waiting').length} tone="amber" />
      </div>
      <h2 className="mb-3 text-lg font-semibold">Upcoming appointments</h2>
      {upcoming.length ? (
        <AppointmentList appointments={upcoming.slice(0, 5)} role="patient" />
      ) : (
        <div className="card text-sm text-slate-500">
          No upcoming appointments. <Link to="/patient/doctors" className="font-medium text-brand-700 hover:underline">Browse doctors</Link> to book one.
        </div>
      )}
    </div>
  );
}

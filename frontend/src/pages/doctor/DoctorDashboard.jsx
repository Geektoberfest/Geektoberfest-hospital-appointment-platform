import { Link } from 'react-router-dom';
import * as availabilityApi from '../../api/availabilityApi';
import * as doctorApi from '../../api/doctorApi';
import * as waitingListApi from '../../api/waitingListApi';
import StatCard from '../../components/admin/StatCard';
import AppointmentList from '../../components/appointments/AppointmentList';
import Alert from '../../components/common/Alert';
import PageHeader from '../../components/common/PageHeader';
import { SkeletonStatGrid, SkeletonTable } from '../../components/common/Skeleton';
import useAuth from '../../hooks/useAuth';
import useFetch from '../../hooks/useFetch';
import { todayString } from '../../utils/format';

export default function DoctorDashboard() {
  const { user } = useAuth();
  const appts = useFetch(() => doctorApi.getMyDoctorAppointments());
  const avail = useFetch(() => availabilityApi.getMyAvailability({ from: todayString() }));
  const waiting = useFetch(() => waitingListApi.listWaitingList({ status: 'waiting' }));

  // The header depends only on the signed-in user, so the loading and loaded states share
  // it: showing the real header while data loads avoids a layout jump.
  const header = (
    <PageHeader
      title={`Welcome, Dr. ${user.name.replace(/^Dr\.?\s*/i, '')}`}
      subtitle="Your schedule at a glance"
      actions={<Link to="/doctor/availability" className="btn-primary">Manage availability</Link>}
    />
  );

  // While any request is in flight, mirror the loaded dashboard: the four stat cards, then
  // the next appointments table. The status region announces the state once.
  if (appts.loading || avail.loading || waiting.loading) {
    return (
      <div>
        {header}
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading dashboard…</span>
          <SkeletonStatGrid count={4} />
          <h2 className="mb-3 text-lg font-semibold">Next appointments</h2>
          <SkeletonTable rows={5} columns={5} />
        </div>
      </div>
    );
  }

  const today = todayString();
  const all = appts.data || [];
  const booked = all.filter((a) => a.status === 'booked' && a.date >= today);
  const todays = booked.filter((a) => a.date === today);

  return (
    <div>
      {header}
      <Alert>{appts.error || avail.error || waiting.error}</Alert>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Today's appointments" value={todays.length} tone="sky" />
        <StatCard label="Upcoming booked" value={booked.length} tone="brand" />
        <StatCard label="Open availability windows" value={(avail.data || []).length} tone="emerald" />
        <StatCard label="Patients waiting" value={(waiting.data || []).length} tone="amber" />
      </div>
      <h2 className="mb-3 text-lg font-semibold">Next appointments</h2>
      <AppointmentList
        appointments={[...booked].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)).slice(0, 5)}
        role="doctor"
      />
    </div>
  );
}

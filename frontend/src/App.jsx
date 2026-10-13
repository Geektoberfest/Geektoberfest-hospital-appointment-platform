import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/common/Layout';
import ProtectedRoute, { homeFor } from './components/common/ProtectedRoute';
import useAuth from './hooks/useAuth';
import Spinner from './components/common/Spinner';

import Login from './pages/auth/Login';
import Register from './pages/auth/Register';

import PatientDashboard from './pages/patient/PatientDashboard';
import Doctors from './pages/patient/Doctors';
import DoctorDetails from './pages/patient/DoctorDetails';
import AvailableSlots from './pages/patient/AvailableSlots';
import BookAppointment from './pages/patient/BookAppointment';
import MyAppointments from './pages/patient/MyAppointments';
import PatientAppointmentDetails from './pages/patient/AppointmentDetails';
import WaitingList from './pages/patient/WaitingList';
import PatientProfile from './pages/patient/Profile';

import DoctorDashboard from './pages/doctor/DoctorDashboard';
import DoctorProfile from './pages/doctor/Profile';
import AvailabilityManagement from './pages/doctor/AvailabilityManagement';
import DoctorAppointments from './pages/doctor/Appointments';
import DoctorAppointmentDetails from './pages/doctor/AppointmentDetails';

import AdminDashboard from './pages/admin/AdminDashboard';
import AdminDoctors from './pages/admin/Doctors';
import AdminPatients from './pages/admin/Patients';
import AdminDepartments from './pages/admin/Departments';
import AdminAppointments from './pages/admin/Appointments';
import AdminWaitingLists from './pages/admin/WaitingLists';
import AnalyticsDashboard from './pages/admin/AnalyticsDashboard';
import AuditLogs from './pages/admin/AuditLogs';
import Sessions from './pages/Sessions';

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  return <Navigate to={homeFor(user?.role)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route element={<ProtectedRoute roles={['patient']} />}>
        <Route element={<Layout />}>
          <Route path="/patient" element={<PatientDashboard />} />
          <Route path="/patient/doctors" element={<Doctors />} />
          <Route path="/patient/doctors/:id" element={<DoctorDetails />} />
          <Route path="/patient/doctors/:id/slots" element={<AvailableSlots />} />
          <Route path="/patient/doctors/:id/book" element={<BookAppointment />} />
          <Route path="/patient/appointments" element={<MyAppointments />} />
          <Route path="/patient/appointments/:id" element={<PatientAppointmentDetails />} />
          <Route path="/patient/waiting-list" element={<WaitingList />} />
          <Route path="/patient/profile" element={<PatientProfile />} />
          <Route path="/patient/sessions" element={<Sessions />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute roles={['doctor']} />}>
        <Route element={<Layout />}>
          <Route path="/doctor" element={<DoctorDashboard />} />
          <Route path="/doctor/profile" element={<DoctorProfile />} />
          <Route path="/doctor/availability" element={<AvailabilityManagement />} />
          <Route path="/doctor/appointments" element={<DoctorAppointments />} />
          <Route path="/doctor/appointments/:id" element={<DoctorAppointmentDetails />} />
          <Route path="/doctor/sessions" element={<Sessions />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute roles={['admin']} />}>
        <Route element={<Layout />}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/doctors" element={<AdminDoctors />} />
          <Route path="/admin/patients" element={<AdminPatients />} />
          <Route path="/admin/departments" element={<AdminDepartments />} />
          <Route path="/admin/appointments" element={<AdminAppointments />} />
          <Route path="/admin/waiting-list" element={<AdminWaitingLists />} />
          <Route path="/admin/analytics" element={<AnalyticsDashboard />} />
          <Route path="/admin/audit-logs" element={<AuditLogs />} />
          <Route path="/admin/sessions" element={<Sessions />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import useAuth from '../../hooks/useAuth';
import NotificationBanner from './NotificationBanner';

const NAV = {
  patient: [
    ['/patient', 'Dashboard', true],
    ['/patient/doctors', 'Find Doctors'],
    ['/patient/appointments', 'My Appointments'],
    ['/patient/waiting-list', 'Waiting List'],
    ['/patient/profile', 'Profile'],
    ['/patient/sessions', 'Sessions'],
  ],
  doctor: [
    ['/doctor', 'Dashboard', true],
    ['/doctor/availability', 'Availability'],
    ['/doctor/appointments', 'Appointments'],
    ['/doctor/profile', 'Profile'],
    ['/doctor/sessions', 'Sessions'],
  ],
  admin: [
    ['/admin', 'Dashboard', true],
    ['/admin/doctors', 'Doctors'],
    ['/admin/patients', 'Patients'],
    ['/admin/departments', 'Departments'],
    ['/admin/appointments', 'Appointments'],
    ['/admin/waiting-list', 'Waiting Lists'],
    ['/admin/analytics', 'Analytics'],
    ['/admin/audit-logs', 'Audit Logs'],
    ['/admin/sessions', 'Sessions'],
  ],
};

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const links = NAV[user.role] || [];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen md:flex">
      <aside className={`${open ? 'block' : 'hidden'} w-full shrink-0 bg-brand-900 text-brand-100 md:block md:w-60`}>
        <div className="flex items-center gap-2 px-5 py-5 text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-bold">+</span>
          <span className="text-lg font-semibold">MediSlot</span>
        </div>
        <nav className="space-y-1 px-3 pb-4" aria-label="Main navigation">
          {links.map(([to, label, end]) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand-700 text-white' : 'hover:bg-brand-800'}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:px-8">
          <button type="button" className="btn-secondary btn-sm md:hidden" onClick={() => setOpen((o) => !o)}>
            Menu
          </button>
          <div className="hidden text-sm text-slate-500 md:block">Hospital Appointment Platform</div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium text-slate-800">{user.name}</p>
              <p className="text-xs capitalize text-slate-500">{user.role}</p>
            </div>
            <button type="button" id="logout-button" className="btn-secondary btn-sm" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <NotificationBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

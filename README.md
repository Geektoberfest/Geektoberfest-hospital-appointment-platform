# Hospital Appointment Allocation Platform

**SIH Problem Statement:** SIH260136 — Hospital Appointment Allocation Platform

A full-stack MERN application for managing hospital departments, doctor profiles, doctor availability, appointment scheduling, and patient waiting lists.

## Live Deployment

- **Frontend:** https://hospital-appointment-platform-front.vercel.app
- **Login:** https://hospital-appointment-platform-front.vercel.app/login
- **Backend API:** https://hospital-appointment-platform.onrender.com
- **Health check:** https://hospital-appointment-platform.onrender.com/api/health

> The health endpoint reports whether the API and its MongoDB connection are available. If the backend URL changes, update the links above.

## Problem Statement

Hospitals can struggle with inefficient scheduling, conflicting bookings, and underused appointment capacity when bookings are cancelled. This platform aims to provide a baseline system for patients, doctors, and administrators to manage appointments and availability.

- **Patients** can find doctors, view available slots, book appointments, manage appointments, and join waiting lists.
- **Doctors** can publish availability, view appointments, and manage their profiles.
- **Administrators** can manage departments, doctors, patients, appointments, and waiting lists.
- **Conflict prevention** uses database-level appointment constraints to prevent duplicate bookings for the same doctor, date, and time slot.
- **Waiting-list reassignment** is designed to offer newly freed slots to eligible waiting patients after cancellation.

## Tech Stack

### Frontend
- React
- Vite
- React Router v7
- Tailwind CSS v4
- Axios

### Backend
- Node.js
- Express.js
- Mongoose
- JSON Web Tokens (JWT)
- bcryptjs
- CORS

### Database
- MongoDB, local or MongoDB Atlas

## Features

### Authentication and Authorization
- JWT-based authentication for patients, doctors, and administrators.
- Password hashing using `bcryptjs`.
- Passwords excluded from API responses.
- Role-based middleware for protected endpoints.

### Patient Portal
- Patient dashboard and appointment statistics.
- Search for doctors by name, department, or specialization.
- View generated availability slots.
- Book appointments with validation against past or duplicate bookings.
- View, filter, and cancel appointments.
- Join and view waiting-list entries.
- Manage profile information.

### Doctor Portal
- View daily and upcoming appointment information.
- Create and manage availability windows and slot durations.
- Filter appointments and update consultation status.
- Manage doctor profile details.

### Admin Portal
- View system statistics.
- Create, update, and deactivate departments.
- Onboard and manage doctor profiles.
- Search patients and manage account status.
- Review appointments and waiting lists.

> Feature descriptions reflect the supplied project documentation. Confirm behavior against the current implementation when testing or contributing.

## Project Structure

```text
hospital-appointment-platform/
├── backend/
│   ├── config/
│   │   └── db.js
│   ├── controllers/
│   ├── middlewares/
│   ├── models/
│   ├── routes/
│   ├── scripts/
│   │   └── seed.js
│   ├── utils/
│   ├── .env.example
│   ├── package.json
│   └── server.js
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── context/
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── utils/
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── .gitignore
└── README.md
```

## Deployment

The frontend and backend are deployed separately.

| Component | Platform | Root directory | Build command | Run/publish setting |
|---|---|---|---|---|
| Frontend | Vercel | `frontend` | `npm run build` | Output directory: `dist` |
| Backend | Render | `backend` | `npm ci` | Start command: `npm start` |
| Database | MongoDB Atlas | — | — | Connection via `MONGO_URI` |

### Frontend environment variable

Set this in Vercel project settings for Production (and Preview only if appropriate):

```env
VITE_API_URL=https://hospital-appointment-platform.onrender.com/api
```

Vite embeds `VITE_` variables during the build. Redeploy the frontend after changing this value.

### Backend environment variables

Set these in the Render backend service's Environment settings:

```env
NODE_ENV=production
MONGO_URI=<your MongoDB Atlas connection string>
JWT_SECRET=<a long, random, unique production secret>
ACCESS_TOKEN_EXPIRES_IN=15m
CLIENT_URL=https://hospital-appointment-platform-front.vercel.app
TRUST_PROXY=1
```

Access tokens are short lived (15 minutes by default) and bound to a session id. The long-lived credential is a refresh token stored in an HttpOnly cookie, so the frontend origin in `CLIENT_URL` must be allowed for credentialed requests. `JWT_EXPIRES_IN` is no longer used; see [issue-15-changes.md](issue-15-changes.md) for the refresh-token, session-revocation and audit-logging settings (`REFRESH_TOKEN_TTL_DAYS`, `REFRESH_TOKEN_GRACE_MS`, `REFRESH_COOKIE_SAMESITE`, `REFRESH_COOKIE_SECURE`).

The waiting-list notification stream (`SSE_TICKET_TTL_MS`, `SSE_HEARTBEAT_MS`, `SSE_MAX_TICKETS`) and its reverse-proxy requirements are documented in [issue-11-changes.md](issue-11-changes.md). `CLIENT_URL` must contain the frontend origin because the browser's `EventSource` connects cross-origin.

Render supplies `PORT` automatically. Do not commit `.env` files, database credentials, JWT secrets, or real admin passwords.

`CLIENT_URL` must match the deployed frontend origin exactly. The backend configuration can accept multiple comma-separated origins if needed.

### Health check

Open [Backend health check](https://hospital-appointment-platform.onrender.com/api/health). A healthy response should contain:

```json
{
  "success": true,
  "message": "API is running",
  "data": {
    "status": "ok",
    "database": "connected"
  }
}
```

The endpoint may include additional fields such as uptime and timestamp. A `503` response indicates that the database is not connected.

## Local Development Setup

### Prerequisites

- Node.js v18 or later (use a Node version supported by the installed Vite version)
- npm
- MongoDB running locally or a MongoDB Atlas connection string

### 1. Clone the repository

```bash
git clone https://github.com/tanishqkale91-cmd/hospital-appointment-platform.git
cd hospital-appointment-platform
```

### 2. Set up the backend

```bash
cd backend
npm ci
cp .env.example .env
```

Update `backend/.env` for your environment. For local MongoDB, the example URI is:

```env
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb://127.0.0.1:27017/hospital_appointments
JWT_SECRET=<your local development secret>
ACCESS_TOKEN_EXPIRES_IN=15m
CLIENT_URL=http://localhost:5173

ADMIN_NAME=System Admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<choose a strong local admin password>
```

Seed the initial admin account and departments if required:

```bash
npm run seed
```

Start the backend:

```bash
npm run dev
```

The backend defaults to port `5000`.

### 3. Set up the frontend

Open a second terminal from the repository root:

```bash
cd frontend
npm ci
cp .env.example .env
```

Set `frontend/.env`:

```env
VITE_API_URL=http://localhost:5000/api
```

Start the frontend development server:

```bash
npm run dev
```

Vite typically serves the frontend at `http://localhost:5173`.

### 4. Build the frontend

From the `frontend/` directory:

```bash
npm run build
```

## API Overview

The following endpoints are documented by the project:

| Method | Endpoint | Access | Description |
|---|---|---|---|
| `GET` | `/api/health` | Public | API and database health |
| `POST` | `/api/auth/register` | Public | Register a patient or doctor |
| `POST` | `/api/auth/login` | Public | Log in and receive a JWT (sets the refresh cookie) |
| `POST` | `/api/auth/refresh` | Refresh cookie + CSRF header | Rotate the refresh token and issue a new access token |
| `POST` | `/api/auth/logout` | Refresh cookie + CSRF header | Revoke this device's session and clear the cookies |
| `GET` | `/api/auth/sessions` | Authenticated | List the caller's active sessions |
| `DELETE` | `/api/auth/sessions/:id` | Authenticated | Revoke one of the caller's sessions |
| `DELETE` | `/api/auth/sessions` | Authenticated | Revoke all of the caller's sessions |
| `GET` | `/api/auth/me` | Authenticated | Get the current user |
| `GET` | `/api/admin/audit-logs` | Admin | Paginated, filterable audit trail |
| `GET` | `/api/departments` | Public | List active departments |
| `POST` | `/api/departments` | Admin | Create a department |
| `GET` | `/api/doctors` | Authenticated | List/search doctors |
| `GET` | `/api/doctors/:id` | Authenticated | Get doctor details |
| `GET` | `/api/availability/doctor/:doctorId` | Authenticated | Get doctor availability |
| `GET` | `/api/availability/doctor/:doctorId/slots` | Authenticated | Get computed slots for a date |
| `POST` | `/api/availability` | Doctor | Publish availability |
| `POST` | `/api/appointments` | Patient | Book an appointment |
| `GET` | `/api/appointments/my` | Patient | View the patient's appointments |
| `PATCH` | `/api/appointments/:id/cancel` | Patient/Doctor/Admin | Cancel an appointment and trigger waiting-list handling |
| `PATCH` | `/api/appointments/:id/status` | Doctor/Admin | Update appointment status |
| `POST` | `/api/notifications/ticket` | Patient | Issue a short-lived single-use ticket for the notification stream |
| `GET` | `/api/notifications/stream` | Ticket (query string) | Server-Sent Events stream of waiting-list reassignment notices |
| `POST` | `/api/waiting-list` | Patient | Join a waiting list |
| `GET` | `/api/waiting-list/my` | Patient | View waiting-list entries |
| `GET` | `/api/users/stats` | Admin | Get system statistics |

## Basic Workflow

1. **Administrator:** Sign in with a deliberately configured admin account, manage departments, and onboard doctors.
2. **Doctor:** Publish availability windows, for example `09:00–12:00` with 30-minute slots.
3. **Patient:** Register, find a doctor, select an available slot, and book an appointment.
4. **Double-booking check:** Attempt to book the same doctor/date/slot twice and verify that the duplicate is rejected.
5. **Waiting list:** Join a waiting list for a fully booked date, then test the configured reassignment behavior after an appointment is cancelled.

Do not assume example admin credentials work in production. Use the seeder's configured environment values and verify the resulting account securely.

## Security Notes

- Keep `.env` files and secrets out of version control.
- Use unique production secrets and strong database credentials.
- Restrict MongoDB Atlas network access to the narrowest practical range. Avoid leaving `0.0.0.0/0` enabled permanently.
- Allow only trusted frontend origins through `CLIENT_URL`.
- Never use example credentials for a public deployment.
- Do not include real patient data in screenshots, issues, logs, or test fixtures.

## Contributing

1. Fork the repository or create a feature branch.
2. Make focused changes and describe them clearly.
3. Test relevant flows before opening a pull request.
4. Do not commit `.env` files, credentials, or personal patient information.
5. Include screenshots for UI changes where useful.

## License

Add a `LICENSE` file if the project is intended to be distributed under a specific open-source license.

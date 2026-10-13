require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { authRateLimiter } = require('./middlewares/rateLimiter');
const { requestContext } = require('./middlewares/requestContext');

const app = express();

// Behind Render/Vercel the real client IP arrives in X-Forwarded-For. Set
// TRUST_PROXY=1 there so rate limiting and audit records see the real IP.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((s) => s.trim());
// credentials:true lets the browser store/send the HttpOnly refresh cookie.
// The origin must stay an explicit allowlist (never '*') for that to be allowed.
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(requestContext);
app.use(express.json({ limit: '1mb' }));

app.use('/api/health', require('./routes/healthRoutes'));
app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/register', authRateLimiter);
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/doctors', require('./routes/doctorRoutes'));
app.use('/api/patients', require('./routes/patientRoutes'));
app.use('/api/departments', require('./routes/departmentRoutes'));
app.use('/api/availability', require('./routes/availabilityRoutes'));
app.use('/api/appointments', require('./routes/appointmentRoutes'));
app.use('/api/waiting-list', require('./routes/waitingListRoutes'));
// SSE stream for waiting-list reassignments (ticket + stream endpoints).
app.use('/api/notifications', require('./routes/notificationRoutes'));

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not defined. Check your .env file.');
    await connectDB();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = app;

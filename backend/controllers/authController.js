const User = require('../models/User');
const Doctor = require('../models/Doctor');
const RefreshToken = require('../models/RefreshToken');
const generateToken = require('../utils/generateToken');
const { isValidEmail } = require('../utils/validators');
const { recordAudit } = require('../utils/auditLog');
const {
  REFRESH_COOKIE,
  REUSE_GRACE_MS,
  hashToken,
  setRefreshCookie,
  clearRefreshCookie,
  storeRefreshToken,
  createSession,
  revokeFamily,
  revokeAllSessions,
} = require('../utils/session');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { createDoctorAccount } = require('./doctorController');
const { clearCache } = require('../config/redis');

const doctorPopulate = [
  { path: 'department', select: 'name' },
];

const invalidSession = (res, message) => {
  clearRefreshCookie(res);
  throw new HttpError(401, message);
};

// POST /api/auth/register  (public: patient or doctor; admins are never self-created)
const register = asyncHandler(async (req, res) => {
  const { name, email, password, role = 'patient', phone } = req.body;

  if (role === 'admin') throw new HttpError(403, 'Admin accounts cannot be created via registration');
  if (!['patient', 'doctor'].includes(role)) throw new HttpError(400, 'Role must be patient or doctor');
  if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
  if (!isValidEmail(email)) throw new HttpError(400, 'A valid email is required');
  if (typeof password !== 'string' || password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters');
  }
  if (await User.findOne({ email: email.toLowerCase().trim() })) {
    throw new HttpError(409, 'Email is already registered');
  }

  let user;
  let doctor = null;
  if (role === 'doctor') {
    ({ user, doctor } = await createDoctorAccount({ ...req.body, name, email, password, phone }));
    await clearCache('doctors:*');
  } else {
    user = await User.create({ name, email, password, role: 'patient', phone });
  }

  const { accessToken } = await createSession(req, res, user);
  res.status(201).json({
    success: true,
    message: 'Registration successful',
    data: { token: accessToken, user, doctor },
  });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    throw new HttpError(400, 'Email and password are required');
  }
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new HttpError(401, 'Invalid email or password');
  }
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');

  const doctor = user.role === 'doctor' ? await Doctor.findOne({ user: user._id }).populate(doctorPopulate) : null;
  const { accessToken } = await createSession(req, res, user);
  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: { token: accessToken, user, doctor },
  });
});

// POST /api/auth/refresh  (cookie-based; rotates the refresh token and issues a new access token)
const refresh = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) throw new HttpError(401, 'Refresh token missing');
  const tokenHash = hashToken(raw);

  // Claim the token atomically so two concurrent refreshes cannot both succeed.
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null },
    { usedAt: new Date() },
    { new: true }
  );
  if (!claimed) {
    const stored = await RefreshToken.findOne({ tokenHash });
    if (!stored) invalidSession(res, 'Invalid refresh token');
    if (stored.revokedAt) invalidSession(res, 'Session has been revoked');

    // Token was already rotated. Inside the grace window it is a concurrent tab; after it,
    // the cookie was replayed, so revoke the whole session.
    if (stored.usedAt && Date.now() - stored.usedAt.getTime() > REUSE_GRACE_MS) {
      await revokeFamily(stored.family);
      await recordAudit({
        req,
        action: 'auth.refresh_reuse_detected',
        outcome: 'denied',
        actor: { _id: stored.user },
        targetType: 'session',
        targetId: stored.family,
      });
      invalidSession(res, 'Refresh token reuse detected; session revoked');
    }
    throw new HttpError(401, 'Refresh token already used');
  }

  if (claimed.expiresAt <= new Date()) invalidSession(res, 'Refresh token expired');
  const user = await User.findById(claimed.user);
  if (!user || !user.isActive) {
    await revokeFamily(claimed.family);
    invalidSession(res, 'Account is unavailable');
  }

  const nextRaw = await storeRefreshToken(req, { userId: user._id, family: claimed.family });
  setRefreshCookie(res, nextRaw);
  res.status(200).json({
    success: true,
    message: 'Session refreshed',
    data: { token: generateToken(user._id, claimed.family) },
  });
});

// POST /api/auth/logout  (public; revokes the session behind the refresh cookie)
const logout = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) {
    const stored = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
    if (stored) await revokeFamily(stored.family);
  }
  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out', data: null });
});

// POST /api/auth/logout-all  (every device for the current user)
const logoutAll = asyncHandler(async (req, res) => {
  await revokeAllSessions(req.user._id);
  await recordAudit({ req, action: 'session.revoke_all', targetType: 'user', targetId: req.user._id });
  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Signed out of all devices', data: null });
});

// GET /api/auth/sessions  (active devices for the current user)
const listSessions = asyncHandler(async (req, res) => {
  const sessions = await RefreshToken.find({
    user: req.user._id,
    revokedAt: null,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .select('family deviceName ip lastUsedAt createdAt');
  const data = sessions.map((s) => ({
    id: s.family,
    deviceName: s.deviceName,
    ip: s.ip,
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    current: s.family === req.sessionId,
  }));
  res.status(200).json({ success: true, message: 'Sessions retrieved', data });
});

// DELETE /api/auth/sessions/:id  (revoke one of the current user's devices)
const revokeSession = asyncHandler(async (req, res) => {
  const result = await RefreshToken.updateMany(
    { user: req.user._id, family: req.params.id, revokedAt: null },
    { revokedAt: new Date() }
  );
  if (result.matchedCount === 0) throw new HttpError(404, 'Session not found');
  await recordAudit({ req, action: 'session.revoke', targetType: 'session', targetId: req.params.id });
  if (req.params.id === req.sessionId) clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Session revoked', data: null });
});

// GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const doctor =
    req.user.role === 'doctor' ? await Doctor.findOne({ user: req.user._id }).populate(doctorPopulate) : null;
  res.status(200).json({ success: true, message: 'Current user', data: { user: req.user, doctor } });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  listSessions,
  revokeSession,
  getMe,
};

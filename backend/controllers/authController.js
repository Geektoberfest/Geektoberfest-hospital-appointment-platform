const User = require('../models/User');
const Doctor = require('../models/Doctor');
const generateToken = require('../utils/generateToken');
const sessionStore = require('../utils/sessionStore');
const { isValidEmail } = require('../utils/validators');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { recordAudit, AUDIT_ACTIONS } = require('../utils/audit');
const { setAuthCookies } = require('../utils/tokenUtils');
const { createDoctorAccount } = require('./doctorController');
const { clearCache } = require('../config/redis');

const doctorPopulate = [
  { path: 'department', select: 'name' },
];

// POST /api/auth/register  (public: patient or doctor; admins are never self-created)
const register = asyncHandler(async (req, res) => {
  // Express 5 leaves req.body undefined when nothing was parsed (a request without a JSON
  // content type, for example), which is a validation error - not a 500.
  const { name, email, password, role = 'patient', phone } = req.body || {};

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

  // Registration signs the user in, so it establishes a session exactly like login does.
  const { sessionId, refreshToken, csrfToken } = await sessionStore.createSession(user, req);
  setAuthCookies(res, { refreshToken, csrfToken });

  await recordAudit({
    action: AUDIT_ACTIONS.REGISTER_SUCCESS,
    outcome: 'success',
    req,
    actor: user._id,
    actorRole: user.role,
    targetUser: user._id,
    targetType: 'user',
    targetId: String(user._id),
    sessionId,
    description: `New ${user.role} account registered`,
  });

  res.status(201).json({
    success: true,
    message: 'Registration successful',
    data: { token: generateToken(user._id, sessionId), user, doctor },
  });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {}; // same guard as register
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    throw new HttpError(400, 'Email and password are required');
  }
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    // The attempted email is deliberately not recorded (see issue-15-changes.md).
    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      outcome: 'failure',
      req,
      description: 'Login failed: invalid credentials',
    });
    throw new HttpError(401, 'Invalid email or password');
  }
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');

  // Every successful login starts its own session/device record.
  const { sessionId, refreshToken, csrfToken } = await sessionStore.createSession(user, req);
  setAuthCookies(res, { refreshToken, csrfToken });

  await recordAudit({
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    outcome: 'success',
    req,
    actor: user._id,
    actorRole: user.role,
    targetUser: user._id,
    targetType: 'user',
    targetId: String(user._id),
    sessionId,
    description: `Login succeeded for role ${user.role}`,
  });

  const doctor = user.role === 'doctor' ? await Doctor.findOne({ user: user._id }).populate(doctorPopulate) : null;
  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: { token: generateToken(user._id, sessionId), user, doctor },
  });
});

// GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const doctor =
    req.user.role === 'doctor' ? await Doctor.findOne({ user: req.user._id }).populate(doctorPopulate) : null;
  res.status(200).json({ success: true, message: 'Current user', data: { user: req.user, doctor } });
});

module.exports = { register, login, getMe };

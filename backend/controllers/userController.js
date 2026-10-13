const User = require('../models/User');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Appointment = require('../models/Appointment');
const WaitingList = require('../models/WaitingList');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidObjectId, todayString, escapeRegex, pick } = require('../utils/validators');
const { clearCache } = require('../config/redis');
const { recordAudit, AUDIT_ACTIONS } = require('../utils/audit');
const { revokeSessions } = require('../utils/sessionStore');

// GET /api/users?role=&search=  (admin)
const listUsers = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.role) {
    if (!['patient', 'doctor', 'admin'].includes(req.query.role)) throw new HttpError(400, 'Invalid role filter');
    filter.role = req.query.role;
  }
  if (req.query.search) {
    const re = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [{ name: re }, { email: re }];
  }
  const users = await User.find(filter).sort({ createdAt: -1 });
  res.status(200).json({ success: true, message: 'Users retrieved', data: users });
});

// GET /api/users/:id  (admin)
const getUser = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid user id');
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.status(200).json({ success: true, message: 'User retrieved', data: user });
});

// PUT /api/users/:id  (admin) - role and password cannot be changed here
const updateUser = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid user id');
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  const updates = pick(req.body, ['name', 'phone', 'dateOfBirth', 'gender', 'bloodGroup', 'address', 'isActive']);
  if (updates.isActive === false && String(user._id) === String(req.user._id)) {
    throw new HttpError(400, 'You cannot deactivate your own account');
  }
  Object.assign(user, updates);
  await user.save();
  if (user.role === 'doctor') {
    if (updates.isActive !== undefined) {
      await Doctor.updateOne({ user: user._id }, { isActive: user.isActive });
    }
    await clearCache('doctors:*');
  }
  await recordAudit({
    action: AUDIT_ACTIONS.ADMIN_USER_UPDATED,
    outcome: 'success',
    req,
    targetUser: user._id,
    targetType: 'user',
    targetId: String(user._id),
    description: `Admin updated user fields for role ${user.role}`,
    // Field names only: values may contain personal data.
    metadata: { fields: Object.keys(updates) },
  });
  res.status(200).json({ success: true, message: 'User updated', data: user });
});

// DELETE /api/users/:id  (admin) - deactivates the account
const deactivateUser = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid user id');
  if (req.params.id === String(req.user._id)) throw new HttpError(400, 'You cannot deactivate your own account');
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  user.isActive = false;
  await user.save();
  if (user.role === 'doctor') {
    await Doctor.updateOne({ user: user._id }, { isActive: false });
    await clearCache('doctors:*');
  }
  // A deactivated account must not keep usable sessions around for a later reactivation.
  const revokedSessions = await revokeSessions({ user: user._id }, 'account_deactivated');
  await recordAudit({
    action: AUDIT_ACTIONS.ADMIN_USER_DEACTIVATED,
    outcome: 'success',
    req,
    targetUser: user._id,
    targetType: 'user',
    targetId: String(user._id),
    description: `Admin deactivated a ${user.role} account`,
    metadata: { revokedSessions },
  });
  res.status(200).json({ success: true, message: 'User deactivated', data: user });
});

// GET /api/users/stats  (admin)
const getStats = asyncHandler(async (req, res) => {
  const countBy = async (Model, field) => {
    const rows = await Model.aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
    return rows.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {});
  };
  const [patients, doctors, departments, appointmentsByStatus, waitingByStatus, todayAppointments] =
    await Promise.all([
      User.countDocuments({ role: 'patient' }),
      Doctor.countDocuments({ isActive: true }),
      Department.countDocuments({ isActive: true }),
      countBy(Appointment, 'status'),
      countBy(WaitingList, 'status'),
      Appointment.countDocuments({ date: todayString(), status: 'booked' }),
    ]);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  res.status(200).json({
    success: true,
    message: 'Statistics retrieved',
    data: {
      patients,
      doctors,
      departments,
      appointments: { total: sum(appointmentsByStatus), ...appointmentsByStatus },
      waitingList: { total: sum(waitingByStatus), ...waitingByStatus },
      todayAppointments,
    },
  });
});

module.exports = { listUsers, getUser, updateUser, deactivateUser, getStats };

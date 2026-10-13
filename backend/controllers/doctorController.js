const User = require('../models/User');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Appointment = require('../models/Appointment');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidEmail, isValidObjectId, isValidDate, escapeRegex, pick } = require('../utils/validators');
const { getCache, setCache, clearCache } = require('../config/redis');
const { recordAudit, AUDIT_ACTIONS } = require('../utils/audit');
const { revokeSessions } = require('../utils/sessionStore');

const doctorPopulate = [
  { path: 'user', select: 'name email phone isActive' },
  { path: 'department', select: 'name' },
];

const buildDoctorCacheKey = (query, role) => {
  const keys = Object.keys(query || {}).sort();
  const serializedQuery = keys
    .map((k) => `${k}=${encodeURIComponent(query[k] ?? '')}`)
    .join('&');
  return `doctors:role=${role}:${serializedQuery}`;
};

const PROFILE_FIELDS = ['specialization', 'qualification', 'experience', 'consultationFee', 'bio'];

const validateProfileFields = (body) => {
  if (body.specialization !== undefined && !String(body.specialization).trim()) {
    throw new HttpError(400, 'Specialization cannot be empty');
  }
  if (body.experience !== undefined && !(Number(body.experience) >= 0 && Number(body.experience) <= 70)) {
    throw new HttpError(400, 'Experience must be between 0 and 70 years');
  }
  if (body.consultationFee !== undefined && !(Number(body.consultationFee) >= 0)) {
    throw new HttpError(400, 'Consultation fee must be 0 or more');
  }
};

/**
 * Create a User (role doctor) plus its Doctor profile.
 * Shared by public doctor registration and admin doctor creation.
 */
const createDoctorAccount = async (body) => {
  const { name, email, password, phone, departmentId, specialization } = body;
  if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
  if (!isValidEmail(email)) throw new HttpError(400, 'A valid email is required');
  if (typeof password !== 'string' || password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters');
  }
  if (!isValidObjectId(departmentId)) throw new HttpError(400, 'A valid departmentId is required');
  if (!specialization || !String(specialization).trim()) throw new HttpError(400, 'Specialization is required');
  validateProfileFields(body);

  const department = await Department.findById(departmentId);
  if (!department || !department.isActive) throw new HttpError(404, 'Department not found or inactive');
  if (await User.findOne({ email: String(email).toLowerCase().trim() })) {
    throw new HttpError(409, 'Email is already registered');
  }

  const user = await User.create({ name, email, password, phone, role: 'doctor' });
  try {
    const doctor = await Doctor.create({
      user: user._id,
      department: department._id,
      ...pick(body, PROFILE_FIELDS),
    });
    return { user, doctor: await doctor.populate(doctorPopulate) };
  } catch (err) {
    await User.deleteOne({ _id: user._id }); // do not leave an orphan doctor user
    throw err;
  }
};

// GET /api/doctors?department=&specialization=&search=
const listDoctors = asyncHandler(async (req, res) => {
  const role = req.user?.role || 'public';
  const cacheKey = buildDoctorCacheKey(req.query, role);
  const cached = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const { department, specialization, search } = req.query;
  const filter = {};
  if (req.user.role !== 'admin' || req.query.includeInactive !== 'true') filter.isActive = true;
  if (department) {
    if (!isValidObjectId(department)) throw new HttpError(400, 'Invalid department id');
    filter.department = department;
  }
  if (specialization) filter.specialization = new RegExp(escapeRegex(specialization), 'i');

  if (search) {
    const users = await User.find({ name: new RegExp(escapeRegex(search), 'i'), role: 'doctor' }).select('_id');
    filter.user = { $in: users.map((u) => u._id) };
  }

  const doctors = await Doctor.find(filter).populate(doctorPopulate).sort({ createdAt: -1 });
  const payload = { success: true, message: 'Doctors retrieved', data: doctors };
  await setCache(cacheKey, payload);
  res.status(200).json(payload);
});

// GET /api/doctors/:id
const getDoctor = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid doctor id');
  const doctor = await Doctor.findById(req.params.id).populate(doctorPopulate);
  if (!doctor || (!doctor.isActive && req.user.role !== 'admin')) throw new HttpError(404, 'Doctor not found');
  res.status(200).json({ success: true, message: 'Doctor retrieved', data: doctor });
});

// POST /api/doctors  (admin)
const createDoctor = asyncHandler(async (req, res) => {
  const { user, doctor } = await createDoctorAccount(req.body);
  await clearCache('doctors:*');
  await recordAudit({
    action: AUDIT_ACTIONS.ADMIN_DOCTOR_CREATED,
    outcome: 'success',
    req,
    targetUser: user._id,
    targetType: 'doctor',
    targetId: String(doctor._id),
    description: 'Admin onboarded a doctor account',
  });
  res.status(201).json({ success: true, message: 'Doctor created', data: doctor });
});

const applyProfileUpdate = async (doctor, body, { allowAdminFields }) => {
  validateProfileFields(body);
  Object.assign(doctor, pick(body, PROFILE_FIELDS));

  if (allowAdminFields) {
    if (body.departmentId !== undefined) {
      if (!isValidObjectId(body.departmentId)) throw new HttpError(400, 'Invalid departmentId');
      const dep = await Department.findById(body.departmentId);
      if (!dep) throw new HttpError(404, 'Department not found');
      doctor.department = dep._id;
    }
    if (body.isActive !== undefined) {
      doctor.isActive = Boolean(body.isActive);
      await User.updateOne({ _id: doctor.user }, { isActive: doctor.isActive });
    }
  }

  const userUpdates = pick(body, ['name', 'phone']);
  if (userUpdates.name !== undefined && !String(userUpdates.name).trim()) {
    throw new HttpError(400, 'Name cannot be empty');
  }
  if (Object.keys(userUpdates).length) await User.updateOne({ _id: doctor.user }, userUpdates);

  await doctor.save();
  return doctor.populate(doctorPopulate);
};

// GET /api/doctors/me/profile  (doctor)
const getMyProfile = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ user: req.user._id }).populate(doctorPopulate);
  if (!doctor) throw new HttpError(404, 'Doctor profile not found');
  res.status(200).json({ success: true, message: 'Doctor profile retrieved', data: doctor });
});

// PUT /api/doctors/me/profile  (doctor)
const updateMyProfile = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ user: req.user._id });
  if (!doctor) throw new HttpError(404, 'Doctor profile not found');
  const updated = await applyProfileUpdate(doctor, req.body, { allowAdminFields: false });
  await clearCache('doctors:*');
  res.status(200).json({ success: true, message: 'Profile updated', data: updated });
});

// PUT /api/doctors/:id  (admin)
const updateDoctor = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid doctor id');
  const doctor = await Doctor.findById(req.params.id);
  if (!doctor) throw new HttpError(404, 'Doctor not found');
  const updated = await applyProfileUpdate(doctor, req.body, { allowAdminFields: true });
  await clearCache('doctors:*');
  await recordAudit({
    action: AUDIT_ACTIONS.ADMIN_DOCTOR_UPDATED,
    outcome: 'success',
    req,
    targetUser: doctor.user,
    targetType: 'doctor',
    targetId: String(doctor._id),
    description: 'Admin updated a doctor profile',
    metadata: { fields: Object.keys(req.body || {}).slice(0, 20) },
  });
  res.status(200).json({ success: true, message: 'Doctor updated', data: updated });
});

// DELETE /api/doctors/:id  (admin) - deactivates rather than erasing history
const deactivateDoctor = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid doctor id');
  const doctor = await Doctor.findById(req.params.id);
  if (!doctor) throw new HttpError(404, 'Doctor not found');
  doctor.isActive = false;
  await doctor.save();
  await User.updateOne({ _id: doctor.user }, { isActive: false });
  await clearCache('doctors:*');
  const revokedSessions = await revokeSessions({ user: doctor.user }, 'account_deactivated');
  await recordAudit({
    action: AUDIT_ACTIONS.ADMIN_DOCTOR_DEACTIVATED,
    outcome: 'success',
    req,
    targetUser: doctor.user,
    targetType: 'doctor',
    targetId: String(doctor._id),
    description: 'Admin deactivated a doctor account',
    metadata: { revokedSessions },
  });
  res.status(200).json({ success: true, message: 'Doctor deactivated', data: await doctor.populate(doctorPopulate) });
});

// GET /api/doctors/me/appointments?status=&date=  (doctor)
const getMyAppointments = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ user: req.user._id });
  if (!doctor) throw new HttpError(404, 'Doctor profile not found');
  const filter = { doctor: doctor._id };
  if (req.query.status) {
    if (!['booked', 'completed', 'cancelled'].includes(req.query.status)) {
      throw new HttpError(400, 'Invalid status filter');
    }
    filter.status = req.query.status;
  }
  if (req.query.date) {
    if (!isValidDate(req.query.date)) throw new HttpError(400, 'Invalid date filter');
    filter.date = req.query.date;
  }
  const appointments = await Appointment.find(filter)
    .populate(Appointment.populateFields)
    .sort({ date: 1, startTime: 1 });
  res.status(200).json({ success: true, message: 'Appointments retrieved', data: appointments });
});

module.exports = {
  createDoctorAccount,
  listDoctors,
  getDoctor,
  createDoctor,
  getMyProfile,
  updateMyProfile,
  updateDoctor,
  deactivateDoctor,
  getMyAppointments,
};

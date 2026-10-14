const Department = require('../models/Department');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidObjectId } = require('../utils/validators');
const { getCache, setCache, clearCache } = require('../config/redis');
const { recordAudit } = require('../utils/auditLog');

const DEFAULT_DEPARTMENTS = [
  { name: 'General Medicine', description: 'Primary care and general health concerns' },
  { name: 'Cardiology', description: 'Heart and cardiovascular system' },
  { name: 'Neurology', description: 'Brain, spine and nervous system' },
  { name: 'Orthopedics', description: 'Bones, joints and muscles' },
  { name: 'Pediatrics', description: 'Medical care for children' },
];

// GET /api/departments  (public, active only)
const listDepartments = asyncHandler(async (req, res) => {
  const cacheKey = 'departments:all';
  const cached = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  let departments = await Department.find({ isActive: true }).sort({ name: 1 });
  if (departments.length === 0 && (await Department.countDocuments()) === 0) {
    await Department.insertMany(DEFAULT_DEPARTMENTS, { ordered: false }).catch(() => {});
    departments = await Department.find({ isActive: true }).sort({ name: 1 });
  }
  const payload = { success: true, message: 'Departments retrieved', data: departments };
  await setCache(cacheKey, payload);
  res.status(200).json(payload);
});

// GET /api/departments/all  (admin, includes inactive)
const listAllDepartments = asyncHandler(async (req, res) => {
  const departments = await Department.find().sort({ name: 1 });
  res.status(200).json({ success: true, message: 'Departments retrieved', data: departments });
});

// GET /api/departments/:id
const getDepartment = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid department id');
  const department = await Department.findById(req.params.id);
  if (!department) throw new HttpError(404, 'Department not found');
  res.status(200).json({ success: true, message: 'Department retrieved', data: department });
});

// POST /api/departments  (admin)
const createDepartment = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) throw new HttpError(400, 'Department name is required');
  const exists = await Department.findOne({ name: new RegExp(`^${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  if (exists) throw new HttpError(409, 'Department already exists');
  const department = await Department.create({ name, description });
  await clearCache('departments:*');
  await clearCache('doctors:*');
  await recordAudit({ req, action: 'department.create', targetType: 'department', targetId: department._id });
  res.status(201).json({ success: true, message: 'Department created', data: department });
});

// PUT /api/departments/:id  (admin)
const updateDepartment = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid department id');
  const department = await Department.findById(req.params.id);
  if (!department) throw new HttpError(404, 'Department not found');
  const { name, description, isActive } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) throw new HttpError(400, 'Department name cannot be empty');
    department.name = name;
  }
  if (description !== undefined) department.description = description;
  if (isActive !== undefined) department.isActive = Boolean(isActive);
  await department.save();
  await clearCache('departments:*');
  await clearCache('doctors:*');
  await recordAudit({
    req,
    action: 'department.update',
    targetType: 'department',
    targetId: department._id,
    details: { fields: Object.keys(req.body) },
  });
  res.status(200).json({ success: true, message: 'Department updated', data: department });
});

// DELETE /api/departments/:id  (admin) - soft delete
const deactivateDepartment = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid department id');
  const department = await Department.findById(req.params.id);
  if (!department) throw new HttpError(404, 'Department not found');
  department.isActive = false;
  await department.save();
  await clearCache('departments:*');
  await clearCache('doctors:*');
  await recordAudit({ req, action: 'department.deactivate', targetType: 'department', targetId: department._id });
  res.status(200).json({ success: true, message: 'Department deactivated', data: department });
});

module.exports = {
  listDepartments,
  listAllDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deactivateDepartment,
};

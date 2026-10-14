const AuditLog = require('../models/AuditLog');
const { asyncHandler } = require('../middlewares/errorHandler');

const MAX_LIMIT = 200;

// GET /api/admin/audit-logs?action=&outcome=&limit=  (admin, newest first)
const listAuditLogs = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.action) filter.action = String(req.query.action);
  if (req.query.outcome) filter.outcome = String(req.query.outcome);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LIMIT);

  const logs = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate({ path: 'actor', select: 'name email role' });
  res.status(200).json({ success: true, message: 'Audit logs retrieved', data: logs });
});

module.exports = { listAuditLogs };

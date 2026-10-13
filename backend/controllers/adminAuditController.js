const AuditLog = require('../models/AuditLog');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidObjectId, escapeRegex } = require('../utils/validators');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const ACTION_RE = /^[a-z0-9._-]{1,100}$/i;
const SEARCH_RE = /^[\w .@:-]{1,100}$/;

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const parseDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * GET /api/admin/audit-logs?page=&limit=&action=&outcome=&actor=&targetUser=&from=&to=&search=
 *
 * Admin-only (enforced by the router with `protect` + `authorize('admin')`), so
 * ordinary users cannot reach the audit trail by guessing query parameters.
 * Filters are validated and never interpolated into a query as-is, which also
 * blocks regex/operator injection through the search box.
 */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { action, outcome, actor, targetUser, from, to, search } = req.query;
  const filter = {};

  if (action) {
    if (!ACTION_RE.test(String(action))) throw new HttpError(400, 'Invalid action filter');
    filter.action = String(action);
  }
  if (outcome) {
    if (!AuditLog.OUTCOMES.includes(outcome)) throw new HttpError(400, 'Invalid outcome filter');
    filter.outcome = outcome;
  }
  if (actor) {
    if (!isValidObjectId(actor)) throw new HttpError(400, 'Invalid actor id');
    filter.actor = actor;
  }
  if (targetUser) {
    if (!isValidObjectId(targetUser)) throw new HttpError(400, 'Invalid targetUser id');
    filter.targetUser = targetUser;
  }

  const createdAt = {};
  if (from) {
    const parsed = parseDate(from);
    if (!parsed) throw new HttpError(400, 'Invalid from date');
    createdAt.$gte = parsed;
  }
  if (to) {
    const parsed = parseDate(to);
    if (!parsed) throw new HttpError(400, 'Invalid to date');
    createdAt.$lte = parsed;
  }
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;

  if (search) {
    if (!SEARCH_RE.test(String(search))) throw new HttpError(400, 'Invalid search term');
    filter.description = new RegExp(escapeRegex(String(search)), 'i');
  }

  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: 'Audit logs retrieved',
    data: {
      logs,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    },
  });
});

module.exports = { listAuditLogs };

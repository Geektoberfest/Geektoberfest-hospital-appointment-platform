const AuditLog = require('../models/AuditLog');

/**
 * Writes one audit entry. Never throws: a failed audit write must not break the
 * request that triggered it, so errors are logged and swallowed.
 */
const recordAudit = async ({ req, action, outcome = 'success', actor, targetType = '', targetId = '', details = {} }) => {
  try {
    const user = actor || req?.user;
    await AuditLog.create({
      actor: user?._id || null,
      actorRole: user?.role || '',
      action,
      outcome,
      targetType,
      targetId: targetId ? String(targetId) : '',
      ip: req?.ip || '',
      details,
    });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
};

module.exports = { recordAudit };

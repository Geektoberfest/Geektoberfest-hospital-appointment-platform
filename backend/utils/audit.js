const AuditLog = require('../models/AuditLog');
const { sanitizeText, sanitizeMetadata } = require('./redact');

/**
 * Canonical audit action names. Keeping them in one place makes the admin
 * filters predictable and avoids typo-driven gaps in the audit trail.
 */
const AUDIT_ACTIONS = Object.freeze({
  REGISTER_SUCCESS: 'auth.register.success',
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',

  REFRESH_SUCCESS: 'auth.refresh.success',
  REFRESH_FAILED: 'auth.refresh.failed',
  REFRESH_EXPIRED: 'auth.refresh.expired',
  REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  REFRESH_CONCURRENT_TOLERATED: 'auth.refresh.concurrent_tolerated',
  REFRESH_CONCURRENT_CONFLICT: 'auth.refresh.concurrent_conflict',

  SESSION_REVOKED: 'auth.session.revoked',
  SESSION_REVOKED_ALL: 'auth.session.revoked_all',

  RBAC_DENIED: 'rbac.access.denied',
  CSRF_DENIED: 'csrf.denied',

  ADMIN_USER_UPDATED: 'admin.user.updated',
  ADMIN_USER_DEACTIVATED: 'admin.user.deactivated',
  ADMIN_DOCTOR_CREATED: 'admin.doctor.created',
  ADMIN_DOCTOR_UPDATED: 'admin.doctor.updated',
  ADMIN_DOCTOR_DEACTIVATED: 'admin.doctor.deactivated',
});

/** Request context that is safe (and useful) to keep for an investigation. */
const requestContext = (req) => ({
  requestId: sanitizeText(req?.requestId, 128),
  method: sanitizeText(req?.method, 10).toUpperCase(),
  // Query strings are dropped: they can carry tokens/secrets in the wild.
  path: sanitizeText(String(req?.originalUrl || req?.url || '').split('?')[0], 200),
  ip: sanitizeText(req?.ip || '', 45),
  userAgent: sanitizeText(req?.get?.('user-agent') || req?.headers?.['user-agent'] || '', 200),
});

/**
 * Persist one audit record.
 *
 * Never throws: audit logging must not turn a successful security operation into
 * a failed request. The return value reports whether the record was actually
 * written so callers never claim an event was audited when persistence failed.
 *
 * @returns {Promise<{ok: boolean, log?: object, error?: Error}>}
 */
const recordAudit = async ({
  action,
  outcome = 'success',
  req = null,
  actor = null,
  actorRole = '',
  targetUser = null,
  targetType = '',
  targetId = '',
  sessionId = '',
  description = '',
  metadata = null,
} = {}) => {
  try {
    const doc = await AuditLog.create({
      action: sanitizeText(action, 100) || 'unknown',
      outcome,
      actor: actor || req?.user?._id || null,
      actorRole: sanitizeText(actorRole || req?.user?.role || '', 20),
      targetUser: targetUser || null,
      targetType: sanitizeText(targetType, 40),
      targetId: sanitizeText(targetId, 64),
      sessionId: sanitizeText(sessionId || req?.sessionId || '', 64),
      description: sanitizeText(description, 300),
      metadata: metadata ? sanitizeMetadata(metadata) : {},
      ...requestContext(req),
    });
    return { ok: true, log: doc };
  } catch (err) {
    console.error(`[audit] failed to persist "${sanitizeText(action, 100)}": ${err?.message || err}`);
    return { ok: false, error: err };
  }
};

/** Fire-and-forget helper for synchronous middleware (denials that must not block the response). */
const recordAuditAsync = (payload) => {
  recordAudit(payload).catch(() => {});
};

module.exports = { AUDIT_ACTIONS, recordAudit, recordAuditAsync };

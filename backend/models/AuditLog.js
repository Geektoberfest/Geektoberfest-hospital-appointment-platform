const mongoose = require('mongoose');

const OUTCOMES = ['success', 'failure', 'denied', 'error'];

/**
 * Append-only record of security-relevant events (RBAC denials, admin changes,
 * session revocations, refresh-token reuse, authentication events).
 *
 * Records intentionally hold identifiers rather than personal data: no names,
 * emails, passwords, hashes, cookies, authorization headers or raw tokens are
 * ever stored. Values are sanitized in `utils/redact.js` before they reach here.
 *
 * `requestId` correlates every record belonging to one inbound request and is
 * also returned to clients in the `X-Request-Id` response header.
 */
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: 100 },
    outcome: { type: String, enum: OUTCOMES, default: 'success' },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: '', trim: true, maxlength: 20 },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    targetType: { type: String, default: '', trim: true, maxlength: 40 },
    targetId: { type: String, default: '', trim: true, maxlength: 64 },
    sessionId: { type: String, default: '', trim: true, maxlength: 64 },
    requestId: { type: String, default: '', trim: true, maxlength: 128 },
    method: { type: String, default: '', trim: true, maxlength: 10 },
    path: { type: String, default: '', trim: true, maxlength: 200 },
    ip: { type: String, default: '', trim: true, maxlength: 45 },
    userAgent: { type: String, default: '', trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 300 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Newest-first listing (default admin view).
auditLogSchema.index({ createdAt: -1 });
// Filter by event type / outcome / actor.
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ outcome: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ targetUser: 1, createdAt: -1 });
auditLogSchema.index({ requestId: 1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
AuditLog.OUTCOMES = OUTCOMES;

module.exports = AuditLog;

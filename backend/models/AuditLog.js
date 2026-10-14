const mongoose = require('mongoose');

/** Records security-relevant events: RBAC denials, admin changes, session revocations, token reuse. */
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true, trim: true, index: true },
    outcome: { type: String, enum: ['success', 'denied', 'failure'], default: 'success' },
    targetType: { type: String, default: '' },
    targetId: { type: String, default: '' },
    ip: { type: String, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);

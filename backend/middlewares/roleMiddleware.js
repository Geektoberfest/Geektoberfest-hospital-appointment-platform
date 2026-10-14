const { HttpError } = require('./errorHandler');
const { recordAudit } = require('../utils/auditLog');

/** Allow only the listed roles. Must run after `protect`. Denials are written to the audit log. */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Not authenticated'));
  if (!roles.includes(req.user.role)) {
    recordAudit({
      req,
      action: 'rbac.denied',
      outcome: 'denied',
      details: { method: req.method, path: req.originalUrl, required: roles, role: req.user.role },
    });
    return next(new HttpError(403, `Role '${req.user.role}' is not allowed to access this resource`));
  }
  next();
};

module.exports = { authorize };

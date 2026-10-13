const { HttpError } = require('./errorHandler');
const { recordAuditAsync, AUDIT_ACTIONS } = require('../utils/audit');

/**
 * Allow only the listed roles. Must run after `protect`.
 *
 * The role is always read from the authenticated user document (`req.user`),
 * never from request body, query or header data, so a client cannot grant itself
 * privileges. Denied attempts are audited because they are the signal an
 * administrator needs when a lower-privileged account probes protected routes.
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Not authenticated'));
  if (!roles.includes(req.user.role)) {
    recordAuditAsync({
      action: AUDIT_ACTIONS.RBAC_DENIED,
      outcome: 'denied',
      req,
      actor: req.user._id,
      actorRole: req.user.role,
      targetType: 'route',
      targetId: `${req.method} ${req.baseUrl}${req.path}`,
      description: `Role '${req.user.role}' is not allowed to access this resource`,
      metadata: { requiredRoles: roles },
    });
    return next(new HttpError(403, `Role '${req.user.role}' is not allowed to access this resource`));
  }
  next();
};

module.exports = { authorize };

const crypto = require('crypto');
const { HttpError } = require('./errorHandler');
const { recordAuditAsync, AUDIT_ACTIONS } = require('../utils/audit');
const { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, parseCookieHeader } = require('../utils/tokenUtils');

// Only accept request ids we could have generated ourselves.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Attach a correlation id and parsed cookies to every request.
 *
 * The request id is echoed back in `X-Request-Id` and stored on audit records,
 * which lets an administrator follow one request through the audit trail.
 */
const requestContext = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.requestId = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  req.cookies = parseCookieHeader(req.headers.cookie);
  next();
};

/** Constant-time string comparison that tolerates differing lengths. */
const safeCompare = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

/**
 * Double-submit CSRF protection for the cookie-authenticated endpoints
 * (`/api/auth/refresh`, `/api/auth/logout`).
 *
 * The refresh cookie is sent cross-site in production (SameSite=None), so those
 * state-changing endpoints also require the CSRF cookie value echoed in the
 * `X-CSRF-Token` header. A cross-site form/fetch cannot read the CSRF cookie and
 * therefore cannot produce the matching header.
 */
const requireCsrf = (req, res, next) => {
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME] || '';
  const headerToken = req.get(CSRF_HEADER_NAME) || '';
  if (!safeCompare(cookieToken, headerToken)) {
    recordAuditAsync({
      action: AUDIT_ACTIONS.CSRF_DENIED,
      outcome: 'denied',
      req,
      description: `Rejected ${req.method} ${req.path}: invalid or missing CSRF token`,
    });
    return next(new HttpError(403, 'Invalid or missing CSRF token'));
  }
  next();
};

module.exports = { requestContext, requireCsrf };

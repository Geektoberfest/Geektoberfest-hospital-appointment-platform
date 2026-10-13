const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const { HttpError, asyncHandler } = require('./errorHandler');

const extractBearer = (header) => (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '');

/**
 * Require a valid, session-backed Bearer token and attach the user to req.user.
 *
 * Beyond verifying the JWT signature/expiry this checks the session against
 * authoritative server-side state, so revoking a device takes effect on the very
 * next request instead of waiting up to 15 minutes for the access token to age out.
 * When the database cannot be reached the request fails closed (500), which is
 * deliberate: an unavailable session store must never be treated as "still valid".
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractBearer(req.headers.authorization || '');
  if (!token) {
    throw new HttpError(401, 'Not authenticated: token missing');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    throw new HttpError(401, 'Not authenticated: invalid or expired token');
  }

  // Tokens issued before session tracking existed cannot be checked against the
  // revocation list, so they are refused rather than trusted until they expire.
  if (!decoded?.id || !decoded?.sid) {
    throw new HttpError(401, 'Not authenticated: token has no session context, please sign in again');
  }

  const user = await User.findById(decoded.id);
  if (!user) throw new HttpError(401, 'Not authenticated: user no longer exists');
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');

  const activeSession = await RefreshToken.exists({
    sessionId: decoded.sid,
    user: user._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!activeSession) {
    throw new HttpError(401, 'Not authenticated: session has been revoked or expired');
  }

  req.user = user;
  req.sessionId = decoded.sid;
  next();
});

module.exports = { protect };

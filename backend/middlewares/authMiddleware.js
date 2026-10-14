const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { HttpError, asyncHandler } = require('./errorHandler');
const { isSessionActive } = require('../utils/session');

/**
 * Require a valid Bearer access token; attaches the user document to req.user
 * and the session id to req.sessionId. A revoked session fails even if the
 * access token has not expired yet.
 */
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw new HttpError(401, 'Not authenticated: token missing');
  }
  let decoded;
  try {
    decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch (e) {
    throw new HttpError(401, 'Not authenticated: invalid or expired token');
  }
  // Tokens issued before session support have no `sid`; they must sign in again.
  if (!decoded.sid) throw new HttpError(401, 'Not authenticated: session expired, please sign in again');
  if (!(await isSessionActive(decoded.sid))) {
    throw new HttpError(401, 'Not authenticated: session has been revoked');
  }
  const user = await User.findById(decoded.id);
  if (!user) throw new HttpError(401, 'Not authenticated: user no longer exists');
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');
  req.user = user;
  req.sessionId = decoded.sid;
  next();
});

module.exports = { protect };

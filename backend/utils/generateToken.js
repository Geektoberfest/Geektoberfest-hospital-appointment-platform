const jwt = require('jsonwebtoken');

/**
 * Sign a short-lived access token.
 *
 * Access tokens are intentionally short lived (15 minutes by default) and are
 * now bound to the session that created them through the `sid` claim, which is
 * what makes immediate revocation possible: the authorization middleware looks
 * the session up in the database on every protected request.
 */
const generateToken = (userId, sessionId) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined');
  }
  if (!sessionId) {
    throw new Error('sessionId is required to sign an access token');
  }
  return jwt.sign({ id: userId, sid: sessionId }, process.env.JWT_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  });
};

module.exports = generateToken;

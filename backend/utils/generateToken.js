const jwt = require('jsonwebtoken');

/**
 * Short-lived access token (sent as a Bearer header). `sid` ties it to the
 * refresh-token family it was issued from, so revoking a session also
 * invalidates its access token on the next request.
 */
const generateToken = (userId, sessionId) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined');
  }
  return jwt.sign({ id: userId, sid: sessionId }, process.env.JWT_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  });
};

module.exports = generateToken;

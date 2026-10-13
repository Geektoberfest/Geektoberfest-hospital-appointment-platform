const { rateLimit } = require('express-rate-limit');

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.',
  },
});

/**
 * Refresh runs on every expiry (and for every open tab), so it needs a much
 * higher ceiling than login/register while still capping replay flooding.
 */
const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many token refresh attempts. Please try again later.',
  },
});

module.exports = { authRateLimiter, refreshRateLimiter };

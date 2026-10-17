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

/**
 * Dedicated rate limiter for notification ticket generation and SSE streams.
 * Prevents ticket flooding and connection exhaustion attacks, while skipping
 * in automated test runs (NODE_ENV=test).
 */
const notificationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many notification requests. Please try again later.',
  },
});

module.exports = { authRateLimiter, refreshRateLimiter, notificationRateLimiter };

const router = require('express').Router();
const { register, login, getMe } = require('../controllers/authController');
const { refresh, logout, listSessions, revokeSession, revokeAllSessions } = require('../controllers/sessionController');
const { protect } = require('../middlewares/authMiddleware');
const { requireCsrf } = require('../middlewares/requestContext');
const { refreshRateLimiter } = require('../middlewares/rateLimiter');

// Public: credentials in, tokens/cookies out.
router.post('/register', register);
router.post('/login', login);

// Cookie-authenticated, so CSRF-protected (they must work after the access token expired).
router.post('/refresh', refreshRateLimiter, requireCsrf, refresh);
router.post('/logout', requireCsrf, logout);

// Session management for the signed-in user (Bearer access token).
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:id', protect, revokeSession);
router.delete('/sessions', protect, revokeAllSessions);

router.get('/me', protect, getMe);

module.exports = router;

const router = require('express').Router();
const { createTicket, openStream } = require('../controllers/notificationController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/roleMiddleware');
const { notificationRateLimiter } = require('../middlewares/rateLimiter');

// Ticket issuance is an ordinary authenticated request, so it uses the standard
// bearer-token middleware, rate limiting, and is limited to the role that can receive waiting-list
// reassignments.
router.post('/ticket', protect, authorize('patient'), notificationRateLimiter, createTicket);

// The stream cannot use the bearer middleware: `EventSource` sends no Authorization
// header. It authenticates with the single-use ticket instead, protected by dedicated rate limiting.
router.get('/stream', notificationRateLimiter, openStream);

module.exports = router;

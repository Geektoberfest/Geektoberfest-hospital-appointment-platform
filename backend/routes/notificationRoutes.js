const router = require('express').Router();
const { issueTicket, streamSSE, streamHealth } = require('../controllers/notificationController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/roleMiddleware');

/**
 * POST /api/notifications/ticket
 * Patient (or any authenticated user) obtains a short-lived single-use ticket
 * to authenticate the upcoming SSE stream request.
 */
router.post('/ticket', protect, authorize('patient'), issueTicket);

/**
 * GET /api/notifications/stream?ticket=<hex>
 * Opens the SSE stream.  Auth is via the one-time ticket (not Bearer header,
 * because EventSource cannot set arbitrary headers).
 */
router.get('/stream', streamSSE);

/**
 * GET /api/notifications/health  (admin only)
 * Returns the count of currently connected SSE clients.
 */
router.get('/health', protect, authorize('admin'), streamHealth);

module.exports = router;

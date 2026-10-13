const router = require('express').Router();
const { createTicket, openStream } = require('../controllers/notificationController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/roleMiddleware');

// Ticket issuance is an ordinary authenticated request, so it uses the standard
// bearer-token middleware and is limited to the role that can receive waiting-list
// reassignments.
router.post('/ticket', protect, authorize('patient'), createTicket);

// The stream cannot use the bearer middleware: `EventSource` sends no Authorization
// header. It authenticates with the single-use ticket instead, which is bound to the
// user it was issued to. Never add `protect` here.
router.get('/stream', openStream);

module.exports = router;

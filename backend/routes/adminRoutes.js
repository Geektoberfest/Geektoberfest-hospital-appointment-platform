const router = require('express').Router();
const { getAnalytics } = require('../controllers/adminAnalyticsController');
const { listAuditLogs } = require('../controllers/auditController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/roleMiddleware');

router.use(protect, authorize('admin'));

router.get('/analytics', getAnalytics);
router.get('/audit-logs', listAuditLogs);

module.exports = router;

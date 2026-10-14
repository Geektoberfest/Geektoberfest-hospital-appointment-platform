const router = require('express').Router();
const { register, login, getMe, refresh, logout, logoutAll, listSessions, revokeSession } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', protect, getMe);
router.post('/logout-all', protect, logoutAll);
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:id', protect, revokeSession);

module.exports = router;

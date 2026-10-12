const router = require('express').Router();
const c = require('../controllers/appointmentController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/roleMiddleware');

router.use(protect);

router.post('/', authorize('patient'), c.bookAppointment);
router.get('/', authorize('admin'), c.listAppointments);
router.get('/my', authorize('patient'), c.getMyAppointments);
router.get('/:id', c.getAppointment); // ownership checked in controller
router.patch('/:id/cancel', c.cancelAppointment); // ownership checked in controller
router.patch('/:id/status', authorize('doctor', 'admin'), c.updateAppointmentStatus);
router.post('/:id/review', authorize('patient'), c.submitAppointmentReview);

module.exports = router;

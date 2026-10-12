const Appointment = require('../models/Appointment');
const Availability = require('../models/Availability');
const Doctor = require('../models/Doctor');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidObjectId, isValidDate, isValidTime, isPastSlot } = require('../utils/validators');
const { assignFromWaitingList } = require('./waitingListController');
const { clearCache } = require('../config/redis');

const STATUSES = ['booked', 'completed', 'cancelled'];

const loadAppointment = async (id) => {
  if (!isValidObjectId(id)) throw new HttpError(400, 'Invalid appointment id');
  const appointment = await Appointment.findById(id);
  if (!appointment) throw new HttpError(404, 'Appointment not found');
  return appointment;
};

/** Whether the requesting user may see/act on this appointment. Returns role as actor or null. */
const getActor = async (user, appointment) => {
  if (user.role === 'admin') return 'admin';
  if (user.role === 'patient' && String(appointment.patient) === String(user._id)) return 'patient';
  if (user.role === 'doctor') {
    const doctor = await Doctor.findOne({ user: user._id });
    if (doctor && String(doctor._id) === String(appointment.doctor)) return 'doctor';
  }
  return null;
};

const respond = async (res, status, message, appointment, extra = {}) => {
  await appointment.populate(Appointment.populateFields);
  res.status(status).json({ success: true, message, data: appointment, ...extra });
};

// POST /api/appointments  (patient)
const bookAppointment = asyncHandler(async (req, res) => {
  const { doctorId, date, startTime, reason = '' } = req.body;
  if (!isValidObjectId(doctorId)) throw new HttpError(400, 'A valid doctorId is required');
  if (!isValidDate(date)) throw new HttpError(400, 'Date must be a valid YYYY-MM-DD');
  if (!isValidTime(startTime)) throw new HttpError(400, 'Start time must be HH:MM');
  if (typeof reason !== 'string' || reason.length > 500) throw new HttpError(400, 'Reason must be under 500 characters');
  if (isPastSlot(date, startTime)) throw new HttpError(400, 'Cannot book a slot in the past');

  const doctor = await Doctor.findById(doctorId);
  if (!doctor || !doctor.isActive) throw new HttpError(404, 'Doctor not found');

  const found = await Availability.findSlot(doctor._id, date, startTime);
  if (!found) throw new HttpError(400, 'The requested slot is not part of the doctor\'s availability');

  if (await Appointment.exists({ doctor: doctor._id, date, startTime, status: { $in: Appointment.ACTIVE_STATUSES } })) {
    throw new HttpError(409, 'This slot is already booked');
  }
  if (await Appointment.exists({ patient: req.user._id, doctor: doctor._id, date, status: { $in: Appointment.ACTIVE_STATUSES } })) {
    throw new HttpError(409, 'You already have an appointment with this doctor on that date');
  }
  if (await Appointment.exists({ patient: req.user._id, date, startTime, status: { $in: Appointment.ACTIVE_STATUSES } })) {
    throw new HttpError(409, 'You already have another appointment at that time');
  }

  let appointment;
  try {
    appointment = await Appointment.create({
      patient: req.user._id,
      doctor: doctor._id,
      department: doctor.department,
      date,
      startTime,
      endTime: found.slot.endTime,
      reason,
    });
  } catch (err) {
    // Two requests racing for the same slot: the unique index decides the winner.
    if (err.code === 11000) throw new HttpError(409, 'This slot was just booked by someone else');
    throw err;
  }
  await respond(res, 201, 'Appointment booked', appointment);
});

// GET /api/appointments  (admin)  ?status=&doctor=&date=
const listAppointments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) throw new HttpError(400, 'Invalid status filter');
    filter.status = req.query.status;
  }
  if (req.query.doctor) {
    if (!isValidObjectId(req.query.doctor)) throw new HttpError(400, 'Invalid doctor id');
    filter.doctor = req.query.doctor;
  }
  if (req.query.date) {
    if (!isValidDate(req.query.date)) throw new HttpError(400, 'Invalid date filter');
    filter.date = req.query.date;
  }
  const items = await Appointment.find(filter)
    .populate(Appointment.populateFields)
    .sort({ date: -1, startTime: -1 });
  res.status(200).json({ success: true, message: 'Appointments retrieved', data: items });
});

// GET /api/appointments/my  (patient)  ?status=
const getMyAppointments = asyncHandler(async (req, res) => {
  const filter = { patient: req.user._id };
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) throw new HttpError(400, 'Invalid status filter');
    filter.status = req.query.status;
  }
  const items = await Appointment.find(filter)
    .populate(Appointment.populateFields)
    .sort({ date: -1, startTime: -1 });
  res.status(200).json({ success: true, message: 'Appointments retrieved', data: items });
});

// GET /api/appointments/:id
const getAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadAppointment(req.params.id);
  if (!(await getActor(req.user, appointment))) {
    throw new HttpError(403, 'You are not allowed to view this appointment');
  }
  await respond(res, 200, 'Appointment retrieved', appointment);
});

/** Cancel a booked appointment, then offer the freed slot to the waiting list. */
const cancelAndReassign = async (appointment, actor, cancellationReason = '') => {
  if (appointment.status !== 'booked') {
    throw new HttpError(409, `Only booked appointments can be cancelled (current status: ${appointment.status})`);
  }
  appointment.status = 'cancelled';
  appointment.cancelledBy = actor;
  if (cancellationReason) {
    appointment.cancellationReason = cancellationReason;
  }
  await appointment.save();
  return assignFromWaitingList(appointment);
};

// PATCH /api/appointments/:id/cancel  (patient own / doctor own / admin)
const cancelAppointment = asyncHandler(async (req, res) => {
  const appointment = await loadAppointment(req.params.id);
  const actor = await getActor(req.user, appointment);
  if (!actor) throw new HttpError(403, 'You are not allowed to cancel this appointment');

  const { cancellationReason, reason } = req.body || {};
  const reasonInput = cancellationReason !== undefined ? cancellationReason : reason;

  if (actor === 'patient') {
    if (!reasonInput || typeof reasonInput !== 'string' || !reasonInput.trim()) {
      throw new HttpError(400, 'Cancellation reason is required');
    }
    if (reasonInput.trim().length > 500) {
      throw new HttpError(400, 'Cancellation reason must be under 500 characters');
    }
  } else if (reasonInput !== undefined) {
    if (typeof reasonInput !== 'string') {
      throw new HttpError(400, 'Cancellation reason must be a string');
    }
    if (reasonInput.trim().length > 500) {
      throw new HttpError(400, 'Cancellation reason must be under 500 characters');
    }
  }

  const trimmedReason = reasonInput ? reasonInput.trim() : '';
  const reassigned = await cancelAndReassign(appointment, actor, trimmedReason);
  await respond(res, 200, 'Appointment cancelled', appointment, {
    reassignedAppointmentId: reassigned ? reassigned._id : null,
  });
});

// PATCH /api/appointments/:id/status  (doctor own / admin)  body: { status, reason, notes, prescription, cancellationReason }
const updateAppointmentStatus = asyncHandler(async (req, res) => {
  const { status, reason, notes, prescription, cancellationReason } = req.body;
  if (!['completed', 'cancelled'].includes(status)) {
    throw new HttpError(400, 'Status must be completed or cancelled');
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 1000)) {
    throw new HttpError(400, 'Notes must be under 1000 characters');
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
    throw new HttpError(400, 'Reason must be under 500 characters');
  }
  if (prescription !== undefined && (typeof prescription !== 'string' || prescription.length > 2000)) {
    throw new HttpError(400, 'Prescription must be under 2000 characters');
  }
  if (cancellationReason !== undefined && (typeof cancellationReason !== 'string' || cancellationReason.length > 500)) {
    throw new HttpError(400, 'Cancellation reason must be under 500 characters');
  }
  const appointment = await loadAppointment(req.params.id);
  const actor = await getActor(req.user, appointment);
  if (actor !== 'doctor' && actor !== 'admin') {
    throw new HttpError(403, 'Only the treating doctor or an admin can update the status');
  }
  if (notes !== undefined) appointment.notes = notes;
  if (reason !== undefined) appointment.reason = reason;
  if (prescription !== undefined) appointment.prescription = prescription;

  let reassigned = null;
  if (status === 'cancelled') {
    const cancelReason = cancellationReason !== undefined ? cancellationReason.trim() : (reason !== undefined ? reason.trim() : '');
    reassigned = await cancelAndReassign(appointment, actor, cancelReason);
  } else {
    if (appointment.status !== 'booked') {
      throw new HttpError(409, `Only booked appointments can be completed (current status: ${appointment.status})`);
    }
    appointment.status = 'completed';
    await appointment.save();
  }
  await respond(res, 200, `Appointment ${status}`, appointment, {
    reassignedAppointmentId: reassigned ? reassigned._id : null,
  });
});

// POST /api/appointments/:id/review  (patient own)  body: { rating, comment }
const submitAppointmentReview = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) throw new HttpError(400, 'Invalid appointment id');

  const { rating, comment = '' } = req.body || {};

  if (rating === undefined || rating === null) {
    throw new HttpError(400, 'Rating is required');
  }
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpError(400, 'Rating must be an integer between 1 and 5');
  }
  if (typeof comment !== 'string') {
    throw new HttpError(400, 'Comment must be a string');
  }
  if (comment.length > 1000) {
    throw new HttpError(400, 'Comment must be under 1000 characters');
  }

  const appointment = await loadAppointment(id);

  if (String(appointment.patient) !== String(req.user._id)) {
    throw new HttpError(403, 'You can only review your own appointments');
  }
  if (appointment.status !== 'completed') {
    throw new HttpError(409, `Only completed appointments can be reviewed (current status: ${appointment.status})`);
  }
  if (appointment.review && appointment.review.rating) {
    throw new HttpError(409, 'This consultation has already been reviewed');
  }

  // Atomic update to ensure no concurrent review submissions succeed
  const updated = await Appointment.findOneAndUpdate(
    {
      _id: appointment._id,
      patient: req.user._id,
      status: 'completed',
      $or: [
        { 'review.rating': { $exists: false } },
        { 'review.rating': null },
      ],
    },
    {
      $set: {
        review: {
          rating,
          comment: comment.trim(),
          reviewedAt: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!updated) {
    throw new HttpError(409, 'This consultation has already been reviewed');
  }

  // Recalculate doctor rating aggregates accurately from persisted reviews
  const stats = await Appointment.aggregate([
    {
      $match: {
        doctor: updated.doctor,
        'review.rating': { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$review.rating' },
        reviewCount: { $sum: 1 },
      },
    },
  ]);

  if (stats.length > 0) {
    await Doctor.updateOne(
      { _id: updated.doctor },
      {
        ratingAverage: Math.round(stats[0].averageRating * 10) / 10,
        reviewCount: stats[0].reviewCount,
      }
    );
  }

  await clearCache('doctors:*');

  await respond(res, 201, 'Review submitted successfully', updated);
});

module.exports = {
  bookAppointment,
  listAppointments,
  getMyAppointments,
  getAppointment,
  cancelAppointment,
  updateAppointmentStatus,
  submitAppointmentReview,
};

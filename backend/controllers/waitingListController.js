const WaitingList = require('../models/WaitingList');
const Appointment = require('../models/Appointment');
const Availability = require('../models/Availability');
const Doctor = require('../models/Doctor');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidObjectId, isValidDate, isValidTime, todayString, isPastSlot } = require('../utils/validators');
const notifications = require('../services/notificationService');

/** Event name the patient's browser listens for (see frontend/src/context/NotificationContext.jsx). */
const WAITLIST_ASSIGNED_EVENT = 'waitlist.assigned';

/**
 * Display name for the notification payload only.
 *
 * Best effort on purpose: this value is cosmetic, and a patient must never lose an
 * already-booked reassigned slot because a name lookup failed. Called strictly after the
 * appointment and the waiting-list entry are persisted.
 */
const lookupDoctorName = async (doctorId, known) => {
  if (known?.user?.name) return known.user.name;
  try {
    const populated = await Doctor.findById(doctorId).populate('user', 'name');
    return populated?.user?.name || '';
  } catch {
    return '';
  }
};

/**
 * Minimal, non-sensitive description of the reassigned appointment.
 * Deliberately limited to what the patient needs to recognise the booking: no medical
 * notes, no reason text, no contact details and no credentials.
 */
const buildAssignmentPayload = async ({ appointment, entry, doctor }) => ({
  appointmentId: String(appointment._id),
  waitingListEntryId: String(entry._id),
  date: appointment.date,
  startTime: appointment.startTime,
  endTime: appointment.endTime,
  doctorName: await lookupDoctorName(appointment.doctor, doctor),
  specialization: doctor?.specialization || '',
  status: appointment.status || 'booked',
});

/**
 * Called after an appointment is cancelled. Gives the freed slot to the first
 * eligible waiting entry (oldest first) for the same doctor and date whose
 * preferred time is empty or matches the freed slot.
 * Returns the newly created appointment or null.
 */
const assignFromWaitingList = async (cancelled) => {
  if (isPastSlot(cancelled.date, cancelled.startTime)) return null;
  const found = await Availability.findSlot(cancelled.doctor, cancelled.date, cancelled.startTime);
  if (!found) return null; // window was removed in the meantime

  const candidates = await WaitingList.find({
    doctor: cancelled.doctor,
    desiredDate: cancelled.date,
    status: 'waiting',
    patient: { $ne: cancelled.patient },
    preferredTime: { $in: ['', null, cancelled.startTime] },
  }).sort({ createdAt: 1 });

  const doctor = await Doctor.findById(cancelled.doctor);
  for (const entry of candidates) {
    const alreadyBooked = await Appointment.exists({
      patient: entry.patient,
      doctor: cancelled.doctor,
      date: cancelled.date,
      status: { $in: Appointment.ACTIVE_STATUSES },
    });
    if (alreadyBooked) continue;
    try {
      const appointment = await Appointment.create({
        patient: entry.patient,
        doctor: cancelled.doctor,
        department: doctor ? doctor.department : undefined,
        date: cancelled.date,
        startTime: cancelled.startTime,
        endTime: cancelled.endTime,
        reason: entry.notes || 'Assigned from waiting list',
      });
      entry.status = 'assigned';
      entry.appointment = appointment._id;
      await entry.save();

      // Only now, once both writes have succeeded, tell the patient. Delivery errors are
      // caught separately so a notification can never undo a persisted reassignment, and
      // this runs exactly once per successful assignment (the loop returns immediately).
      try {
        notifications.notifyUser(
          entry.patient,
          WAITLIST_ASSIGNED_EVENT,
          await buildAssignmentPayload({ appointment, entry, doctor })
        );
      } catch (err) {
        console.error(`[waiting-list] assignment notification failed: ${err?.message || err}`);
      }

      return appointment;
    } catch (err) {
      if (err.code === 11000) continue; // slot or patient time already taken, try the next entry
      throw err;
    }
  }
  return null;
};

// POST /api/waiting-list  (patient)
const joinWaitingList = asyncHandler(async (req, res) => {
  const { doctorId, desiredDate, preferredTime = '', notes = '' } = req.body;
  if (!isValidObjectId(doctorId)) throw new HttpError(400, 'A valid doctorId is required');
  if (!isValidDate(desiredDate)) throw new HttpError(400, 'Desired date must be a valid YYYY-MM-DD');
  if (desiredDate < todayString()) throw new HttpError(400, 'Desired date cannot be in the past');
  if (preferredTime && !isValidTime(preferredTime)) throw new HttpError(400, 'Preferred time must be HH:MM');

  const doctor = await Doctor.findById(doctorId);
  if (!doctor || !doctor.isActive) throw new HttpError(404, 'Doctor not found');

  if (await Appointment.exists({ patient: req.user._id, doctor: doctor._id, date: desiredDate, status: { $in: Appointment.ACTIVE_STATUSES } })) {
    throw new HttpError(409, 'You already have an appointment with this doctor on that date');
  }
  if (await WaitingList.exists({ patient: req.user._id, doctor: doctor._id, desiredDate, status: 'waiting' })) {
    throw new HttpError(409, 'You are already on the waiting list for this doctor and date');
  }

  // Waiting list is only for fully booked days: if a suitable slot is free, book it instead.
  const windows = await Availability.find({ doctor: doctor._id, date: desiredDate, isActive: true });
  const booked = await Appointment.find({ doctor: doctor._id, date: desiredDate, status: { $in: Appointment.ACTIVE_STATUSES } }).select('startTime');
  const taken = new Set(booked.map((b) => b.startTime));
  const freeSlots = windows
    .flatMap((w) => w.getSlots())
    .filter((s) => !taken.has(s.startTime) && !isPastSlot(desiredDate, s.startTime));
  if (preferredTime) {
    if (freeSlots.some((s) => s.startTime === preferredTime)) {
      throw new HttpError(400, 'That slot is currently available, please book it directly');
    }
  } else if (freeSlots.length) {
    throw new HttpError(400, 'Slots are available on that date, please book one directly');
  }

  const entry = await WaitingList.create({
    patient: req.user._id,
    doctor: doctor._id,
    desiredDate,
    preferredTime,
    notes,
  });
  await entry.populate(WaitingList.populateFields);
  res.status(201).json({ success: true, message: 'Added to the waiting list', data: entry });
});

// GET /api/waiting-list/my  (patient)
const getMyWaitingList = asyncHandler(async (req, res) => {
  const entries = await WaitingList.find({ patient: req.user._id })
    .populate(WaitingList.populateFields)
    .sort({ createdAt: -1 });
  res.status(200).json({ success: true, message: 'Waiting list entries retrieved', data: entries });
});

// GET /api/waiting-list?status=  (doctor: own doctor's list, admin: everything)
const getWaitingList = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === 'doctor') {
    const doctor = await Doctor.findOne({ user: req.user._id });
    if (!doctor) throw new HttpError(404, 'Doctor profile not found');
    filter.doctor = doctor._id;
  }
  if (req.query.status) {
    if (!['waiting', 'assigned', 'cancelled'].includes(req.query.status)) {
      throw new HttpError(400, 'Invalid status filter');
    }
    filter.status = req.query.status;
  }
  const entries = await WaitingList.find(filter)
    .populate(WaitingList.populateFields)
    .sort({ desiredDate: 1, createdAt: 1 });
  res.status(200).json({ success: true, message: 'Waiting list retrieved', data: entries });
});

// DELETE /api/waiting-list/:id  (patient own / admin) - cancels the entry
const cancelWaitingEntry = asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid waiting list id');
  const entry = await WaitingList.findById(req.params.id);
  if (!entry) throw new HttpError(404, 'Waiting list entry not found');
  if (req.user.role !== 'admin' && String(entry.patient) !== String(req.user._id)) {
    throw new HttpError(403, 'You can only cancel your own waiting list entries');
  }
  if (entry.status !== 'waiting') throw new HttpError(409, `Entry is already ${entry.status}`);
  entry.status = 'cancelled';
  await entry.save();
  res.status(200).json({ success: true, message: 'Waiting list entry cancelled', data: entry });
});

module.exports = {
  assignFromWaitingList,
  joinWaitingList,
  getMyWaitingList,
  getWaitingList,
  cancelWaitingEntry,
  WAITLIST_ASSIGNED_EVENT,
};

const Availability = require('../models/Availability');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const {
  isValidObjectId,
  isValidDate,
  isValidTime,
  todayString,
  toMinutes,
  isPastSlot,
  generateSlots,
} = require('../utils/validators');

const getOwnDoctor = async (user) => {
  const doctor = await Doctor.findOne({ user: user._id });
  if (!doctor) throw new HttpError(404, 'Doctor profile not found');
  if (!doctor.isActive) throw new HttpError(403, 'Doctor account is deactivated');
  return doctor;
};

const validateBreaks = (breaks, windowStart, windowEnd) => {
  if (!Array.isArray(breaks) || !breaks.length) return;
  const wStart = toMinutes(windowStart);
  const wEnd = toMinutes(windowEnd);

  for (const b of breaks) {
    if (!isValidTime(b.startTime) || !isValidTime(b.endTime)) {
      throw new HttpError(400, 'Break times must be HH:MM');
    }
    const bStart = toMinutes(b.startTime);
    const bEnd = toMinutes(b.endTime);
    if (bEnd <= bStart) {
      throw new HttpError(400, 'Break end time must be after break start time');
    }
    if (bStart < wStart || bEnd > wEnd) {
      throw new HttpError(400, 'Break must fall within the availability window');
    }
  }
};

/** Validate an availability window; throws 400 on bad input. */
const validateWindow = (body) => {
  const { isRecurring, date, daysOfWeek, startTime, endTime, slotDuration, breaks, startDate, endDate } = body;

  if (isRecurring) {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      throw new HttpError(400, 'Recurring schedules require at least one day of the week (0-6)');
    }
    if (daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new HttpError(400, 'Days of week must be integers between 0 (Sunday) and 6 (Saturday)');
    }
    if (startDate && !isValidDate(startDate)) {
      throw new HttpError(400, 'startDate must be a valid YYYY-MM-DD');
    }
    if (endDate && !isValidDate(endDate)) {
      throw new HttpError(400, 'endDate must be a valid YYYY-MM-DD');
    }
    if (startDate && endDate && endDate < startDate) {
      throw new HttpError(400, 'endDate cannot be before startDate');
    }
  } else {
    if (!isValidDate(date)) throw new HttpError(400, 'Date must be a valid YYYY-MM-DD');
    if (date < todayString()) throw new HttpError(400, 'Date cannot be in the past');
    if (date === todayString() && isPastSlot(date, endTime)) {
      throw new HttpError(400, 'The availability window has already ended');
    }
  }

  if (!isValidTime(startTime) || !isValidTime(endTime)) throw new HttpError(400, 'Times must be HH:MM (24h)');
  if (toMinutes(endTime) <= toMinutes(startTime)) throw new HttpError(400, 'End time must be after start time');
  if (!Number.isInteger(slotDuration) || slotDuration < 10 || slotDuration > 120) {
    throw new HttpError(400, 'Slot duration must be a whole number between 10 and 120 minutes');
  }

  validateBreaks(breaks, startTime, endTime);

  if (generateSlots(startTime, endTime, slotDuration).length === 0) {
    throw new HttpError(400, 'The window is shorter than a single slot');
  }
};

const assertNoOverlap = async (doctorId, windowData, excludeId) => {
  const { isRecurring, date, daysOfWeek, startTime, endTime } = windowData;
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);

  const query = {
    doctor: doctorId,
    isActive: true,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  };

  const others = await Availability.find(query);
  const proposed = { ...windowData, isRecurring: Boolean(isRecurring) };
  if (others.some((other) => windowsOverlap(proposed, other))) {
    throw new HttpError(409, 'This availability overlaps with an existing window');
  }
};

const dateForDayOffset = (date, offset) => {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(Date.UTC(y, m - 1, d + offset));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
};

const occursOn = (window, date) => {
  if (!window.isRecurring) return window.date === date;
  if (window.startDate && date < window.startDate) return false;
  if (window.endDate && date > window.endDate) return false;
  const [y, m, d] = date.split('-').map(Number);
  return (window.daysOfWeek || []).includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
};

const hasCommonOccurrence = (a, b) => {
  if (!a.isRecurring && !b.isRecurring) return a.date === b.date;
  if (!a.isRecurring) return occursOn(b, a.date);
  if (!b.isRecurring) return occursOn(a, b.date);
  const first = [a.startDate, b.startDate].filter(Boolean).sort().at(-1) || '1970-01-01';
  const last = [a.endDate, b.endDate].filter(Boolean).sort()[0] || '9999-12-31';
  if (first > last) return false;
  for (let offset = 0; offset < 7; offset += 1) {
    const date = dateForDayOffset(first, offset);
    if (date > last) break;
    const [y, m, d] = date.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if ((a.daysOfWeek || []).includes(day) && (b.daysOfWeek || []).includes(day)) return true;
  }
  return false;
};

const windowsOverlap = (a, b) =>
  hasCommonOccurrence(a, b) &&
  toMinutes(a.startTime) < toMinutes(b.endTime) &&
  toMinutes(b.startTime) < toMinutes(a.endTime);

/** Booked appointments sitting in the slots of an availability window. */
const bookedInWindow = async (availability) => {
  const query = {
    doctor: availability.doctor,
    status: { $in: Appointment.ACTIVE_STATUSES },
  };
  if (!availability.isRecurring) query.date = availability.date;
  else {
    if (availability.startDate || availability.endDate) {
      query.date = {};
      if (availability.startDate) query.date.$gte = availability.startDate;
      if (availability.endDate) query.date.$lte = availability.endDate;
    }
  }
  const appointments = await Appointment.find(query);
  return appointments.filter((appointment) => {
    const date = appointment.date;
    if (!occursOn(availability, date)) return false;
    return availability.getSlots().some((slot) => slot.startTime === appointment.startTime);
  });
};

const slotsForWindow = (window) => {
  const breaks = (window.breaks || []).map((b) => ({ start: toMinutes(b.startTime), end: toMinutes(b.endTime) }));
  return generateSlots(window.startTime, window.endTime, window.slotDuration).filter((slot) => {
    const start = toMinutes(slot.startTime);
    const end = toMinutes(slot.endTime);
    return !breaks.some((b) => start < b.end && b.start < end);
  });
};

const slotStillOffered = (availability, appointment, next) =>
  occursOn(next, appointment.date) &&
  slotsForWindow(next).some((slot) => slot.startTime === appointment.startTime);

// POST /api/availability  (doctor)
const createAvailability = asyncHandler(async (req, res) => {
  const doctor = await getOwnDoctor(req.user);
  const { isRecurring = false, date, daysOfWeek = [], startTime, endTime, breaks = [], startDate = '', endDate = '' } = req.body;
  const slotDuration = req.body.slotDuration === undefined ? 30 : Number(req.body.slotDuration);

  const windowData = { isRecurring, date, daysOfWeek, startTime, endTime, slotDuration, breaks, startDate, endDate };
  validateWindow(windowData);
  await assertNoOverlap(doctor._id, windowData);

  const availability = await Availability.create({
    doctor: doctor._id,
    ...windowData,
  });

  res.status(201).json({ success: true, message: 'Availability created', data: availability });
});

// GET /api/availability/me?from=&includeInactive=  (doctor)
const getMyAvailability = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ user: req.user._id });
  if (!doctor) throw new HttpError(404, 'Doctor profile not found');
  const filter = { doctor: doctor._id };
  if (req.query.includeInactive !== 'true') filter.isActive = true;

  if (req.query.from) {
    if (!isValidDate(req.query.from)) throw new HttpError(400, 'Invalid from date');
    filter.$or = [{ isRecurring: true }, { date: { $gte: req.query.from } }];
  }

  const items = await Availability.find(filter).sort({ isRecurring: -1, date: 1, startTime: 1 });
  res.status(200).json({ success: true, message: 'Availability retrieved', data: items });
});

const loadOwned = async (req) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid availability id');
  const doctor = await getOwnDoctor(req.user);
  const availability = await Availability.findById(req.params.id);
  if (!availability) throw new HttpError(404, 'Availability not found');
  if (String(availability.doctor) !== String(doctor._id)) {
    throw new HttpError(403, 'This availability belongs to another doctor');
  }
  return availability;
};

// PUT /api/availability/:id  (doctor)
const updateAvailability = asyncHandler(async (req, res) => {
  const availability = await loadOwned(req);
  const next = {
    isRecurring: req.body.isRecurring ?? availability.isRecurring,
    date: req.body.date ?? availability.date,
    daysOfWeek: req.body.daysOfWeek ?? availability.daysOfWeek,
    startTime: req.body.startTime ?? availability.startTime,
    endTime: req.body.endTime ?? availability.endTime,
    slotDuration: req.body.slotDuration === undefined ? availability.slotDuration : Number(req.body.slotDuration),
    breaks: req.body.breaks ?? availability.breaks,
    startDate: req.body.startDate ?? availability.startDate,
    endDate: req.body.endDate ?? availability.endDate,
  };
  validateWindow(next);

  const booked = await bookedInWindow(availability);
  const remainsActive = req.body.isActive === undefined ? availability.isActive : Boolean(req.body.isActive);
  if (booked.some((appointment) => !remainsActive || !slotStillOffered(availability, appointment, next))) {
    throw new HttpError(409, 'Update would remove slots that already have booked appointments');
  }

  if (remainsActive) await assertNoOverlap(availability.doctor, next, availability._id);

  Object.assign(availability, next);
  if (req.body.isActive !== undefined) availability.isActive = Boolean(req.body.isActive);
  await availability.save();
  res.status(200).json({ success: true, message: 'Availability updated', data: availability });
});

// DELETE /api/availability/:id  (doctor) - deactivates
const removeAvailability = asyncHandler(async (req, res) => {
  const availability = await loadOwned(req);
  if ((await bookedInWindow(availability)).length) {
    throw new HttpError(409, 'This window has booked appointments; cancel them before removing it');
  }
  availability.isActive = false;
  await availability.save();
  res.status(200).json({ success: true, message: 'Availability removed', data: availability });
});

const loadActiveDoctor = async (id) => {
  if (!isValidObjectId(id)) throw new HttpError(400, 'Invalid doctor id');
  const doctor = await Doctor.findById(id);
  if (!doctor || !doctor.isActive) throw new HttpError(404, 'Doctor not found');
  return doctor;
};

const pad = (n) => String(n).padStart(2, '0');

const addDays = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

const buildSlotView = async (doctorId, windows) => {
  if (!windows.length) return [];
  const dates = [...new Set(windows.map((w) => w.date))];
  const booked = await Appointment.find({
    doctor: doctorId,
    date: { $in: dates },
    status: { $in: Appointment.ACTIVE_STATUSES },
  }).select('date startTime');
  const taken = new Set(booked.map((b) => `${b.date}|${b.startTime}`));

  return windows.map((w) => {
    const suppressRecurringOverlap = (s) => Boolean(w.isRecurring) && windows.some((specific) =>
      !specific.isRecurring && specific.date === w.date &&
      toMinutes(s.startTime) < toMinutes(specific.endTime) &&
      toMinutes(specific.startTime) < toMinutes(s.endTime)
    );
    const slots = (typeof w.getSlots === 'function' ? w.getSlots() : [])
      .filter((s) => !suppressRecurringOverlap(s))
      .map((s) => ({
      ...s,
      date: w.date,
      availabilityId: w._id,
      available: !taken.has(`${w.date}|${s.startTime}`) && !isPastSlot(w.date, s.startTime),
    }));
    return {
      _id: w._id,
      doctor: w.doctor,
      date: w.date,
      startTime: w.startTime,
      endTime: w.endTime,
      slotDuration: w.slotDuration,
      isRecurring: Boolean(w.isRecurring),
      breaks: w.breaks || [],
      slots,
      availableSlots: slots.filter((s) => s.available).length,
    };
  });
};

// GET /api/availability/doctor/:doctorId/slots?date=YYYY-MM-DD
const getDoctorSlots = asyncHandler(async (req, res) => {
  const doctor = await loadActiveDoctor(req.params.doctorId);
  const { date } = req.query;
  if (!isValidDate(date)) throw new HttpError(400, 'A valid date (YYYY-MM-DD) query parameter is required');

  const [y, m, d] = date.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  // Find specific date windows AND matching recurring windows
  const specificWindows = await Availability.find({
    doctor: doctor._id,
    date,
    isRecurring: { $ne: true },
    isActive: true,
  }).sort({ startTime: 1 });

  const recurringWindows = await Availability.find({
    doctor: doctor._id,
    isRecurring: true,
    daysOfWeek: dayOfWeek,
    isActive: true,
  }).sort({ startTime: 1 });

  const activeRecurring = recurringWindows.filter((w) => {
    if (w.startDate && date < w.startDate) return false;
    if (w.endDate && date > w.endDate) return false;
    return true;
  });

  const allWindows = [...specificWindows, ...activeRecurring];

  // Retrieve active booked appointments on this date
  const booked = await Appointment.find({
    doctor: doctor._id,
    date,
    status: { $in: Appointment.ACTIVE_STATUSES },
  }).select('date startTime');
  const taken = new Set(booked.map((b) => `${b.date}|${b.startTime}`));

  const slots = allWindows.flatMap((w) => w.getSlots()
    .filter((s) => !w.isRecurring || !specificWindows.some((specific) =>
      toMinutes(s.startTime) < toMinutes(specific.endTime) &&
      toMinutes(specific.startTime) < toMinutes(s.endTime)
    ))
    .map((s) => ({
      ...s,
      date,
      availabilityId: w._id,
      available: !taken.has(`${date}|${s.startTime}`) && !isPastSlot(date, s.startTime),
    })));

  res.status(200).json({ success: true, message: 'Slots retrieved', data: slots });
});

// GET /api/availability/doctor/:doctorId?from=&to=
const getDoctorAvailability = asyncHandler(async (req, res) => {
  const doctor = await loadActiveDoctor(req.params.doctorId);
  const from = req.query.from || todayString();
  if (!isValidDate(from)) throw new HttpError(400, 'Invalid from date');

  const range = { $gte: from };
  const toDate = req.query.to || addDays(from, 14);
  if (req.query.to) {
    if (!isValidDate(req.query.to)) throw new HttpError(400, 'Invalid to date');
  }
  if (toDate < from) throw new HttpError(400, 'to date cannot be before from date');
  range.$lte = toDate;

  const specificWindows = await Availability.find({
    doctor: doctor._id,
    isActive: true,
    isRecurring: { $ne: true },
    date: range,
  }).sort({ date: 1, startTime: 1 });

  const recurringWindows = await Availability.find({
    doctor: doctor._id,
    isActive: true,
    isRecurring: true,
  }).sort({ startTime: 1 });

  const combinedWindows = [...specificWindows];

  let cur = from;
  while (cur <= toDate) {
    const [y, m, d] = cur.split('-').map(Number);
    const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    for (const rw of recurringWindows) {
      if (rw.daysOfWeek && rw.daysOfWeek.includes(dayOfWeek)) {
        if (rw.startDate && cur < rw.startDate) continue;
        if (rw.endDate && cur > rw.endDate) continue;

        combinedWindows.push({
            _id: rw._id,
            doctor: rw.doctor,
            date: cur,
            startTime: rw.startTime,
            endTime: rw.endTime,
            slotDuration: rw.slotDuration,
            isRecurring: true,
            breaks: rw.breaks,
            getSlots: () => rw.getSlots(),
        });
      }
    }
    cur = addDays(cur, 1);
  }

  combinedWindows.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const data = await buildSlotView(doctor._id, combinedWindows);
  res.status(200).json({ success: true, message: 'Availability retrieved', data });
});


module.exports = {
  createAvailability,
  getMyAvailability,
  updateAvailability,
  removeAvailability,
  getDoctorAvailability,
  getDoctorSlots,
};

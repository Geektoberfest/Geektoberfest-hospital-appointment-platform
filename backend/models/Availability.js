const mongoose = require('mongoose');
const { toMinutes, toTime } = require('../utils/validators');

const breakSchema = new mongoose.Schema(
  {
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true }, // HH:MM
    label: { type: String, default: 'Break' },
  },
  { _id: false }
);

/**
 * Doctor availability window supporting single dates or weekly recurring schedules
 * with lunch break and pause exclusions.
 */
const availabilitySchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    isRecurring: { type: Boolean, default: false },
    date: { type: String, default: '' }, // YYYY-MM-DD (for single date windows)
    daysOfWeek: { type: [Number], default: [] }, // 0=Sun, 1=Mon .. 6=Sat (for recurring)
    startDate: { type: String, default: '' }, // Optional YYYY-MM-DD
    endDate: { type: String, default: '' }, // Optional YYYY-MM-DD
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true }, // HH:MM
    slotDuration: { type: Number, default: 30, min: 10, max: 120 }, // minutes
    breaks: { type: [breakSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

availabilitySchema.index({ doctor: 1, date: 1 });
availabilitySchema.index({ doctor: 1, isRecurring: 1, daysOfWeek: 1 });

/**
 * Compute slots dynamically while excluding configured break windows.
 */
availabilitySchema.methods.getSlots = function getSlots() {
  const slots = [];
  const startM = toMinutes(this.startTime);
  const endM = toMinutes(this.endTime);
  const dur = this.slotDuration;
  const breakRanges = (this.breaks || []).map((b) => ({
    start: toMinutes(b.startTime),
    end: toMinutes(b.endTime),
  }));

  for (let s = startM; s + dur <= endM; s += dur) {
    const slotEnd = s + dur;
    const inBreak = breakRanges.some((b) => s < b.end && b.start < slotEnd);
    if (!inBreak) {
      slots.push({ startTime: toTime(s), endTime: toTime(slotEnd) });
    }
  }
  return slots;
};

/**
 * Find the active availability window that offers a slot starting at
 * `startTime` for a doctor on `date`. Returns { availability, slot } or null.
 */
availabilitySchema.statics.findSlot = async function findSlot(doctorId, date, startTime) {
  // 1. Check specific single-date availability
  const specificWindows = await this.find({
    doctor: doctorId,
    date,
    isRecurring: { $ne: true },
    isActive: true,
  });

  for (const availability of specificWindows) {
    const slot = availability.getSlots().find((s) => s.startTime === startTime);
    if (slot) return { availability, slot };
  }

  // 2. Check weekly recurring availability
  const [y, m, d] = date.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 (Sun) to 6 (Sat)

  const recurringWindows = await this.find({
    doctor: doctorId,
    isRecurring: true,
    daysOfWeek: dayOfWeek,
    isActive: true,
  });

  for (const availability of recurringWindows) {
    if (availability.startDate && date < availability.startDate) continue;
    if (availability.endDate && date > availability.endDate) continue;

    const slot = availability.getSlots().find((s) => s.startTime === startTime);
    if (slot) return { availability, slot };
  }

  return null;
};

module.exports = mongoose.model('Availability', availabilitySchema);

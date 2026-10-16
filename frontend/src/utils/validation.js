// Explicit .js extension keeps this module loadable by plain Node ESM (the test runner),
// matching the convention documented in src/api/axios.js.
import { todayString, nowTimeString } from './format.js';

export const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());

export const validateDate = (date, { allowPast = false } = {}) => {
  if (!date) return 'Date is required';
  if (!allowPast && date < todayString()) return 'Date cannot be in the past';
  return '';
};

/** Validate an availability form; returns an object of field errors. */
export const validateAvailability = ({ date, startTime, endTime, slotDuration, isRecurring, daysOfWeek, startDate, endDate, breaks }) => {
  const errors = {};
  if (isRecurring) {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      errors.daysOfWeek = 'Select at least one day of the week';
    }
    if (startDate && endDate && endDate < startDate) {
      errors.endDate = 'End date cannot be before start date';
    }
  } else {
    const dateErr = validateDate(date);
    if (dateErr) errors.date = dateErr;
    if (date === todayString() && endTime && endTime <= nowTimeString()) errors.endTime = 'This window has already ended';
  }
  if (!startTime) errors.startTime = 'Start time is required';
  if (!endTime) errors.endTime = 'End time is required';
  if (startTime && endTime && endTime <= startTime) errors.endTime = 'End time must be after start time';
  const dur = Number(slotDuration);
  if (!Number.isInteger(dur) || dur < 10 || dur > 120) errors.slotDuration = 'Between 10 and 120 minutes';

  if (Array.isArray(breaks)) {
    for (const b of breaks) {
      if (!b.startTime || !b.endTime) {
        errors.breaks = 'Break start time and end time are required';
      } else if (b.endTime <= b.startTime) {
        errors.breaks = 'Break end time must be after break start time';
      } else if (startTime && endTime && (b.startTime < startTime || b.endTime > endTime)) {
        errors.breaks = 'Break must fall within the working window';
      }
    }
  }

  return errors;
};


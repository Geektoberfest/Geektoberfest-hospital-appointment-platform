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
export const validateAvailability = ({ date, startTime, endTime, slotDuration }) => {
  const errors = {};
  const dateErr = validateDate(date);
  if (dateErr) errors.date = dateErr;
  if (!startTime) errors.startTime = 'Start time is required';
  if (!endTime) errors.endTime = 'End time is required';
  if (startTime && endTime && endTime <= startTime) errors.endTime = 'End time must be after start time';
  if (date === todayString() && endTime && endTime <= nowTimeString()) errors.endTime = 'This window has already ended';
  const dur = Number(slotDuration);
  if (!Number.isInteger(dur) || dur < 10 || dur > 120) errors.slotDuration = 'Between 10 and 120 minutes';
  return errors;
};

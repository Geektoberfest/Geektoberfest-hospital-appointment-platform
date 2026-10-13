const mongoose = require('mongoose');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
const isValidTime = (v) => typeof v === 'string' && TIME_RE.test(v);
/** Session identifiers are random UUIDs, never Mongo ObjectIds. */
const isValidSessionId = (v) => typeof v === 'string' && UUID_RE.test(v.trim());

/** Strict YYYY-MM-DD check that also rejects things like 2025-02-31. */
const isValidDate = (v) => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const pad = (n) => String(n).padStart(2, '0');

/** Today's date (server local time) as YYYY-MM-DD. */
const todayString = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
};

const nowMinutes = () => {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
};

const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const toTime = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/** True when the given date/start time is already in the past. */
const isPastSlot = (date, startTime) => {
  const today = todayString();
  if (date < today) return true;
  if (date === today && toMinutes(startTime) <= nowMinutes()) return true;
  return false;
};

/** Split a window into consecutive slots of `duration` minutes. */
const generateSlots = (startTime, endTime, duration) => {
  const slots = [];
  const end = toMinutes(endTime);
  for (let s = toMinutes(startTime); s + duration <= end; s += duration) {
    slots.push({ startTime: toTime(s), endTime: toTime(s + duration) });
  }
  return slots;
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Copy only whitelisted keys that are present on the source object. */
const pick = (obj, keys) =>
  keys.reduce((acc, k) => {
    if (obj[k] !== undefined) acc[k] = obj[k];
    return acc;
  }, {});

module.exports = {
  isValidEmail,
  isValidObjectId,
  isValidSessionId,
  isValidDate,
  isValidTime,
  todayString,
  toMinutes,
  toTime,
  isPastSlot,
  generateSlots,
  escapeRegex,
  pick,
};

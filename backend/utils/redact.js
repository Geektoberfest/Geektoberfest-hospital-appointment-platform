/**
 * Pure sanitizers for anything that reaches the database, the logs or an API
 * response. Keeping them dependency-free makes them easy to test in isolation.
 */

const REDACTED = '[redacted]';

// Keys whose values must never be persisted, even when a caller passes them by mistake.
const SENSITIVE_KEY_RE = /(pass(word)?|secret|token|authorization|cookie|jwt|hash|otp|pin|csrf|credential|api[_-]?key)/i;

// Control characters (including newlines) allow log-forging, so they are flattened.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const MAX_TEXT = 300;
const MAX_KEY = 60;
const MAX_DEPTH = 3;
const MAX_KEYS = 20;
const MAX_ITEMS = 10;

/** Flatten control characters/whitespace and cap the length of a text value. */
const sanitizeText = (value, maxLength = MAX_TEXT) => {
  if (value === null || value === undefined) return '';
  const text = (typeof value === 'string' ? value : String(value))
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};

/**
 * Recursively sanitize metadata before it is stored:
 * - sensitive keys become `[redacted]`
 * - strings are flattened and truncated
 * - depth, key count and array length are bounded
 */
const sanitizeMetadata = (value, depth = 0) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  // Mongoose ObjectId (and anything else BSON-like) is rendered as its hex string.
  if (typeof value.toHexString === 'function') return sanitizeText(value.toHexString(), 64);

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return '[truncated]';
    return value.slice(0, MAX_ITEMS).map((item) => sanitizeMetadata(item, depth + 1));
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[truncated]';
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      const safeKey = sanitizeText(key, MAX_KEY) || 'unknown';
      out[safeKey] = SENSITIVE_KEY_RE.test(key) ? REDACTED : sanitizeMetadata(value[key], depth + 1);
    }
    return out;
  }

  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return sanitizeText(String(value));
  }
  return sanitizeText(String(value));
};

/** Turn a user agent string into a short, log-safe label such as "Chrome on Windows". */
const BROWSERS = [
  ['Edg', 'Edge'],
  ['OPR', 'Opera'],
  ['Chrome', 'Chrome'],
  ['Safari', 'Safari'],
  ['Firefox', 'Firefox'],
];

const PLATFORMS = [
  ['Windows', 'Windows'],
  ['Android', 'Android'],
  ['iPhone', 'iOS'],
  ['iPad', 'iPadOS'],
  ['Mac OS X', 'macOS'],
  ['Linux', 'Linux'],
];

const describeUserAgent = (userAgent) => {
  const text = sanitizeText(userAgent, 200);
  if (!text) return 'Unknown device';
  const browser = BROWSERS.find(([needle]) => text.includes(needle));
  const platform = PLATFORMS.find(([needle]) => text.includes(needle));
  if (browser && platform) return `${browser[1]} on ${platform[1]}`;
  return browser?.[1] || platform?.[1] || 'Unknown device';
};

module.exports = {
  REDACTED,
  SENSITIVE_KEY_RE,
  CONTROL_CHARS_RE,
  sanitizeText,
  sanitizeMetadata,
  describeUserAgent,
};

const crypto = require('crypto');

/**
 * Refresh-token cryptography, cookie policy and cookie parsing.
 *
 * The raw refresh token is a 48-byte cryptographically random value. Only its
 * SHA-256 hash is stored, so a database leak cannot be replayed against the API.
 */

const REFRESH_COOKIE_NAME = 'refresh_token';
const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

// Refresh cookie is scoped to /api/auth so it is not attached to ordinary API traffic.
const REFRESH_COOKIE_PATH = '/api/auth';
const CSRF_COOKIE_PATH = '/';

const DEFAULT_REFRESH_TTL_DAYS = 30;
const DEFAULT_GRACE_MS = 30000;
const REFRESH_TOKEN_BYTES = 48;
// base64url of 48 bytes is 64 characters; accept a range to stay forward compatible.
const REFRESH_TOKEN_VALUE_RE = /^[A-Za-z0-9_-]{43,128}$/;

const isProduction = () => process.env.NODE_ENV === 'production';

/** Refresh-token lifetime in milliseconds (`REFRESH_TOKEN_TTL_DAYS`, default 30 days). */
const refreshTokenTtlMs = () => {
  const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
  const effective = Number.isFinite(days) && days > 0 ? days : DEFAULT_REFRESH_TTL_DAYS;
  return Math.round(effective * 24 * 60 * 60 * 1000);
};

/** Grace window that keeps two concurrent requests from killing a session (0 disables it). */
const graceWindowMs = () => {
  const raw = process.env.REFRESH_TOKEN_GRACE_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_GRACE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_GRACE_MS;
};

/** Cryptographically secure raw refresh token (the value that goes into the cookie). */
const generateRefreshTokenValue = () => crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

/** SHA-256 hash used as the stored/lookup representation of a refresh token. */
const hashRefreshToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** Cheap shape check so malformed values never reach the database. */
const isValidRefreshTokenValue = (value) => typeof value === 'string' && REFRESH_TOKEN_VALUE_RE.test(value);

/** Opaque identifiers for a session (device) and its token family. */
const generateSessionId = () => crypto.randomUUID();

/** CSRF secret for the double-submit cookie pattern (readable by our own frontend only). */
const generateCsrfToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Cookie policy.
 *
 * The frontend and backend are deployed on different sites (Vercel + Render), so
 * production defaults to `SameSite=None; Secure`. Local development stays on
 * `SameSite=Lax` and non-secure so plain http://localhost keeps working.
 * Everything is configurable for single-origin deployments behind a proxy.
 */
const resolveCookieSecurity = () => {
  const rawSameSite = String(process.env.REFRESH_COOKIE_SAMESITE || (isProduction() ? 'none' : 'lax')).toLowerCase();
  const sameSite = ['lax', 'strict', 'none'].includes(rawSameSite) ? rawSameSite : 'lax';
  const configuredSecure = process.env.REFRESH_COOKIE_SECURE;
  let secure = configuredSecure === undefined || configuredSecure === ''
    ? isProduction()
    : String(configuredSecure).toLowerCase() === 'true';
  // Browsers reject SameSite=None without Secure, so never emit that combination.
  if (sameSite === 'none') secure = true;
  return { secure, sameSite };
};

const refreshCookieOptions = () => ({
  ...resolveCookieSecurity(),
  httpOnly: true,
  path: REFRESH_COOKIE_PATH,
  maxAge: refreshTokenTtlMs(),
});

const csrfCookieOptions = () => ({
  ...resolveCookieSecurity(),
  // Deliberately readable by our own JavaScript: the double-submit pattern needs it.
  httpOnly: false,
  path: CSRF_COOKIE_PATH,
  maxAge: refreshTokenTtlMs(),
});

/** Clear options must mirror the path/security attributes that were used when setting. */
const clearCookieOptions = (path) => ({ ...resolveCookieSecurity(), httpOnly: true, path });

const setAuthCookies = (res, { refreshToken, csrfToken } = {}) => {
  if (refreshToken) res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  if (csrfToken) res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());
};

const clearAuthCookies = (res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, clearCookieOptions(REFRESH_COOKIE_PATH));
  res.clearCookie(CSRF_COOKIE_NAME, { ...clearCookieOptions(CSRF_COOKIE_PATH), httpOnly: false });
};

/**
 * Minimal cookie header parser. The project only needs to read two first-party
 * cookies, which does not justify another runtime dependency (express itself
 * only provides the cookie *writer*).
 */
const parseCookieHeader = (header) => {
  const cookies = {};
  if (typeof header !== 'string' || !header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
};

module.exports = {
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_PATH,
  CSRF_COOKIE_PATH,
  DEFAULT_REFRESH_TTL_DAYS,
  DEFAULT_GRACE_MS,
  refreshTokenTtlMs,
  graceWindowMs,
  generateRefreshTokenValue,
  hashRefreshToken,
  isValidRefreshTokenValue,
  generateSessionId,
  generateCsrfToken,
  refreshCookieOptions,
  csrfCookieOptions,
  setAuthCookies,
  clearAuthCookies,
  parseCookieHeader,
};

const crypto = require('crypto');
const RefreshToken = require('../models/RefreshToken');
const generateToken = require('./generateToken');

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_PATH = '/api/auth';
// Reusing a rotated token within this window is treated as a concurrent request
// (e.g. two browser tabs refreshing at once), not as theft.
const REUSE_GRACE_MS = 30 * 1000;

const refreshTtlMs = () => (Number(process.env.REFRESH_TOKEN_DAYS) || 7) * 24 * 60 * 60 * 1000;

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // The frontend and API live on different domains in production, which needs SameSite=None.
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: REFRESH_COOKIE_PATH,
});

const setRefreshCookie = (res, raw) => {
  res.cookie(REFRESH_COOKIE, raw, { ...cookieOptions(), maxAge: refreshTtlMs() });
};

const clearRefreshCookie = (res) => {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
};

const deviceNameFrom = (req) => String(req.headers['user-agent'] || 'Unknown device').slice(0, 255);

/** Stores a new refresh token for `family` and returns the raw value for the cookie. */
const storeRefreshToken = async (req, { userId, family }) => {
  const raw = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({
    user: userId,
    family,
    tokenHash: hashToken(raw),
    deviceName: deviceNameFrom(req),
    ip: req.ip || '',
    expiresAt: new Date(Date.now() + refreshTtlMs()),
  });
  return raw;
};

/** Starts a new login session (one device) and returns the access token plus the raw refresh token. */
const createSession = async (req, res, user) => {
  const family = crypto.randomUUID();
  const refreshToken = await storeRefreshToken(req, { userId: user._id, family });
  setRefreshCookie(res, refreshToken);
  return { accessToken: generateToken(user._id, family) };
};

/** Revokes every token in one session family. */
const revokeFamily = (family) =>
  RefreshToken.updateMany({ family, revokedAt: null }, { revokedAt: new Date() });

/** Revokes every session a user has, on all devices. */
const revokeAllSessions = (userId) =>
  RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });

/** True while the session family still has an unused, unrevoked, unexpired token. */
const isSessionActive = (family) =>
  RefreshToken.exists({ family, revokedAt: null, usedAt: null, expiresAt: { $gt: new Date() } });

module.exports = {
  REFRESH_COOKIE,
  REUSE_GRACE_MS,
  hashToken,
  setRefreshCookie,
  clearRefreshCookie,
  storeRefreshToken,
  createSession,
  revokeFamily,
  revokeAllSessions,
  isSessionActive,
};

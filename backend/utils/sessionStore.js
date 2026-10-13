const RefreshToken = require('../models/RefreshToken');
const { sanitizeText } = require('./redact');
const {
  generateRefreshTokenValue,
  hashRefreshToken,
  generateSessionId,
  generateCsrfToken,
  refreshTokenTtlMs,
} = require('./tokenUtils');

/**
 * Session/token persistence helpers shared by the auth and admin controllers.
 *
 * A session is the set of refresh-token documents that share a `sessionId`, and
 * a token family is the lineage that shares a `familyId`. Revoking a session
 * therefore revokes its family too.
 */

/** Minimal device context kept with a session so users can recognise their devices. */
const deviceContext = (req) => ({
  userAgent: sanitizeText(req?.get?.('user-agent') || req?.headers?.['user-agent'] || '', 200),
  ip: sanitizeText(req?.ip || '', 45),
});

/**
 * Persist a new refresh token for a session and return the raw value.
 *
 * Only the hash is written; the caller is responsible for putting the raw value
 * into the HttpOnly cookie. A duplicate-key error here means another request
 * already rotated this session (enforced by the partial unique index).
 */
const issueSessionToken = async ({ user, sessionId, familyId, sessionStartedAt = new Date(), req }) => {
  const now = new Date();
  const refreshToken = generateRefreshTokenValue();
  const tokenHash = hashRefreshToken(refreshToken);
  await RefreshToken.create({
    user,
    sessionId,
    familyId,
    tokenHash,
    sessionStartedAt,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + refreshTokenTtlMs()),
    ...deviceContext(req),
  });
  return { refreshToken, tokenHash };
};

/**
 * Start a brand new session (login/registration).
 * Returns the raw refresh token for the caller to put into the HttpOnly cookie;
 * the database keeps only its hash.
 */
const createSession = async (user, req) => {
  const sessionId = generateSessionId();
  const familyId = generateSessionId();
  const { refreshToken } = await issueSessionToken({ user: user._id, sessionId, familyId, req });
  return { sessionId, familyId, refreshToken, csrfToken: generateCsrfToken() };
};

/**
 * Revoke every active token matching `filter`.
 * Returns how many active records were actually revoked.
 */
const revokeSessions = async (filter, reason) => {
  const result = await RefreshToken.updateMany(
    { ...filter, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: sanitizeText(reason, 40) } }
  );
  return result?.modifiedCount ?? 0;
};

/** Active token for one session, scoped to its owner so sessions cannot be enumerated. */
const findActiveSession = (sessionId, userId) =>
  RefreshToken.findOne({ sessionId, user: userId, revokedAt: null, expiresAt: { $gt: new Date() } });

/** Active token for a session (used when the owner is already known from the token itself). */
const findActiveSessionById = (sessionId) =>
  RefreshToken.findOne({ sessionId, revokedAt: null, expiresAt: { $gt: new Date() } });

/**
 * One active token per session by construction, so this is the caller's session list.
 * Only non-sensitive fields are selected: hashes never leave the database.
 */
const listActiveSessions = (userId) =>
  RefreshToken.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select('sessionId sessionStartedAt lastUsedAt expiresAt userAgent ip createdAt')
    .sort({ sessionStartedAt: -1 })
    .lean();

/** Look up a refresh token by the hash of its raw value. */
const findByTokenHash = (tokenHash) => RefreshToken.findOne({ tokenHash });

module.exports = {
  deviceContext,
  createSession,
  issueSessionToken,
  revokeSessions,
  findActiveSession,
  findActiveSessionById,
  listActiveSessions,
  findByTokenHash,
};

const User = require('../models/User');
const Doctor = require('../models/Doctor');
const RefreshToken = require('../models/RefreshToken');
const generateToken = require('../utils/generateToken');
const sessionStore = require('../utils/sessionStore');
const { HttpError, asyncHandler } = require('../middlewares/errorHandler');
const { isValidSessionId } = require('../utils/validators');
const { describeUserAgent } = require('../utils/redact');
const { recordAudit, AUDIT_ACTIONS } = require('../utils/audit');
const {
  REFRESH_COOKIE_NAME,
  hashRefreshToken,
  isValidRefreshTokenValue,
  generateCsrfToken,
  graceWindowMs,
  setAuthCookies,
  clearAuthCookies,
} = require('../utils/tokenUtils');

const doctorPopulate = [{ path: 'department', select: 'name' }];

const loadDoctorProfile = (user) =>
  user.role === 'doctor' ? Doctor.findOne({ user: user._id }).populate(doctorPopulate) : null;

/** Same response shape as login so the frontend can reuse its session handling. */
const sessionPayload = async (user, sessionId) => ({
  token: generateToken(user._id, sessionId),
  user,
  doctor: await loadDoctorProfile(user),
});

const revokedReason = (record) => String(record?.revokedReason || '');

/**
 * POST /api/auth/refresh
 *
 * Rotates the refresh token from the HttpOnly cookie:
 * 1. atomically claims the presented token (only one request can win),
 * 2. issues a successor token for the same session and overwrites the cookie,
 * 3. treats any later replay of the consumed token as compromise and revokes the session.
 */
const refresh = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE_NAME] || '';
  const now = new Date();

  if (!presented) {
    clearAuthCookies(res);
    await recordAudit({
      action: AUDIT_ACTIONS.REFRESH_FAILED,
      outcome: 'failure',
      req,
      description: 'Refresh attempted without a refresh cookie',
    });
    throw new HttpError(401, 'Refresh token missing, please sign in again');
  }

  if (!isValidRefreshTokenValue(presented)) {
    clearAuthCookies(res);
    await recordAudit({
      action: AUDIT_ACTIONS.REFRESH_FAILED,
      outcome: 'failure',
      req,
      description: 'Refresh token was malformed',
    });
    throw new HttpError(401, 'Invalid refresh token, please sign in again');
  }

  const tokenHash = hashRefreshToken(presented);

  // Atomic claim: the conditional update guarantees a token can only be consumed once.
  const current = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, rotatedAt: now, revokedReason: 'rotated', lastUsedAt: now } },
    { new: false }
  );

  if (!current) {
    return handleUnclaimedRefresh({ req, res, tokenHash, now });
  }

  const user = await User.findById(current.user);
  if (!user || !user.isActive) {
    await sessionStore.revokeSessions({ user: current.user }, 'account_inactive');
    clearAuthCookies(res);
    await recordAudit({
      action: AUDIT_ACTIONS.REFRESH_FAILED,
      outcome: 'denied',
      req,
      actor: current.user,
      sessionId: current.sessionId,
      description: 'Refresh rejected: account missing or deactivated',
    });
    throw new HttpError(401, 'Session is no longer valid, please sign in again');
  }

  let issued;
  try {
    issued = await sessionStore.issueSessionToken({
      user: user._id,
      sessionId: current.sessionId,
      familyId: current.familyId,
      sessionStartedAt: current.sessionStartedAt,
      req,
    });
  } catch (err) {
    if (err?.code === 11000) {
      // The partial unique index on sessionId rejects a second live token for the
      // same session, so a racing request cannot fork the session into two chains.
      await recordAudit({
        action: AUDIT_ACTIONS.REFRESH_CONCURRENT_CONFLICT,
        outcome: 'failure',
        req,
        actor: user._id,
        actorRole: user.role,
        sessionId: current.sessionId,
        description: 'Concurrent refresh lost the rotation race; no second token chain was created',
      });
      throw new HttpError(401, 'This refresh request was already completed elsewhere, please retry');
    }
    throw err;
  }

  await RefreshToken.updateOne({ _id: current._id }, { $set: { replacedByHash: issued.tokenHash } });

  // The CSRF secret rotates together with the refresh token so a stolen value ages out.
  setAuthCookies(res, { refreshToken: issued.refreshToken, csrfToken: generateCsrfToken() });

  await recordAudit({
    action: AUDIT_ACTIONS.REFRESH_SUCCESS,
    outcome: 'success',
    req,
    actor: user._id,
    actorRole: user.role,
    sessionId: current.sessionId,
  });

  res.status(200).json({
    success: true,
    message: 'Token refreshed',
    data: await sessionPayload(user, current.sessionId),
  });
});

/**
 * The presented token could not be claimed. Either it never existed, it expired,
 * it was revoked, or it was already rotated (the interesting case).
 */
const handleUnclaimedRefresh = async ({ req, res, tokenHash, now }) => {
  const existing = await sessionStore.findByTokenHash(tokenHash);

  if (!existing) {
    clearAuthCookies(res);
    await recordAudit({
      action: AUDIT_ACTIONS.REFRESH_FAILED,
      outcome: 'failure',
      req,
      description: 'Refresh token not recognised',
    });
    throw new HttpError(401, 'Invalid refresh token, please sign in again');
  }

  if (existing.revokedAt) {
    if (revokedReason(existing) === 'rotated') {
      return handleRotatedTokenReplay({ req, res, existing, now });
    }
    // Logout / explicit revocation / a previously detected replay: already dead.
    clearAuthCookies(res);
    await recordAudit({
      action: AUDIT_ACTIONS.REFRESH_FAILED,
      outcome: 'denied',
      req,
      actor: existing.user,
      sessionId: existing.sessionId,
      description: 'Refresh presented for a revoked session',
      metadata: { reason: revokedReason(existing) },
    });
    throw new HttpError(401, 'Session has been revoked, please sign in again');
  }

  if (new Date(existing.expiresAt).getTime() <= now.getTime()) {
    clearAuthCookies(res);
    await recordAudit({
      action: AUDIT_ACTIONS.REFRESH_EXPIRED,
      outcome: 'failure',
      req,
      actor: existing.user,
      sessionId: existing.sessionId,
      description: 'Refresh token expired',
    });
    throw new HttpError(401, 'Refresh token expired, please sign in again');
  }

  // Still active, yet the claim lost: another request consumed it microseconds ago.
  return handleRotatedTokenReplay({ req, res, existing, now });
};

/**
 * A token that was already rotated is being presented again.
 *
 * Inside the configured grace window, with a live successor in the same family,
 * this is treated as a legitimate concurrent refresh from a second browser tab:
 * the caller receives a fresh access token for the still-active session but no
 * new refresh token. That keeps the replay window bounded (the successor's raw
 * value is never recoverable or re-disclosed) and never extends the session.
 *
 * Outside the window, or with no live successor, the token is being replayed by
 * somebody who should not have it, so the whole session/family is revoked.
 */
const handleRotatedTokenReplay = async ({ req, res, existing, now }) => {
  const graceMs = graceWindowMs();
  const rotatedAt = existing.rotatedAt ? new Date(existing.rotatedAt).getTime() : 0;
  const withinGrace = graceMs > 0 && rotatedAt > 0 && now.getTime() - rotatedAt <= graceMs;

  if (withinGrace) {
    const successor = await sessionStore.findActiveSessionById(existing.sessionId);
    const sameFamily = successor && String(successor.familyId) === String(existing.familyId);
    const user = sameFamily ? await User.findById(existing.user) : null;

    if (user && user.isActive) {
      await recordAudit({
        action: AUDIT_ACTIONS.REFRESH_CONCURRENT_TOLERATED,
        outcome: 'success',
        req,
        actor: user._id,
        actorRole: user.role,
        sessionId: existing.sessionId,
        description: 'Concurrent duplicate refresh tolerated inside the grace window',
        // `issuedNewRefresh` is false on purpose: the consumed token's raw replacement
        // is never recoverable, so a duplicate request must not set a new cookie.
        metadata: { graceMs, issuedNewRefresh: false },
      });
      // No Set-Cookie: the successor token already set by the winning request stays.
      return res.status(200).json({
        success: true,
        message: 'Token refreshed',
        data: await sessionPayload(user, existing.sessionId),
      });
    }
  }

  const revoked = await sessionStore.revokeSessions({ sessionId: existing.sessionId }, 'rotation_reuse_detected');
  clearAuthCookies(res);
  await recordAudit({
    action: AUDIT_ACTIONS.REFRESH_REUSE_DETECTED,
    outcome: 'failure',
    req,
    actor: existing.user,
    sessionId: existing.sessionId,
    description: 'Refresh token reuse detected; the affected session was revoked',
    metadata: { graceMs, withinGrace, revokedSessions: revoked, familyId: existing.familyId },
  });
  throw new HttpError(401, 'Refresh token reuse detected. The session was revoked, please sign in again.');
};

/**
 * POST /api/auth/logout
 *
 * Revokes the caller's current session from the refresh cookie alone, so logout
 * still works after the access token has expired. Always succeeds (idempotent).
 */
const logout = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE_NAME] || '';
  let sessionId = '';

  if (isValidRefreshTokenValue(presented)) {
    const record = await sessionStore.findByTokenHash(hashRefreshToken(presented));
    if (record) {
      sessionId = record.sessionId;
      const revoked = await sessionStore.revokeSessions({ sessionId: record.sessionId }, 'logout');
      await recordAudit({
        action: AUDIT_ACTIONS.LOGOUT,
        outcome: 'success',
        req,
        actor: record.user,
        sessionId: record.sessionId,
        description: 'User signed out of this device',
        metadata: { revokedSessions: revoked },
      });
    }
  }

  clearAuthCookies(res);
  res.status(200).json({ success: true, message: 'Logged out', data: { sessionId: sessionId || null } });
});

// GET /api/auth/sessions
const listSessions = asyncHandler(async (req, res) => {
  const sessions = await sessionStore.listActiveSessions(req.user._id);
  const data = sessions.map((session) => ({
    // Opaque session identifier; matches the `_id` shape the frontend tables expect.
    _id: session.sessionId,
    current: session.sessionId === req.sessionId,
    device: describeUserAgent(session.userAgent),
    startedAt: session.sessionStartedAt,
    lastRefreshedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    ip: session.ip || '',
  }));
  res.status(200).json({ success: true, message: 'Active sessions retrieved', data });
});

// DELETE /api/auth/sessions/:id - revoke one of the caller's own sessions
const revokeSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) throw new HttpError(400, 'Invalid session id');

  // Scoped to the caller, so another user's session simply looks absent.
  const session = await sessionStore.findActiveSession(id, req.user._id);
  if (!session) throw new HttpError(404, 'Session not found');

  const revoked = await sessionStore.revokeSessions({ sessionId: id, user: req.user._id }, 'session_revoked');
  const current = id === req.sessionId;
  if (current) clearAuthCookies(res);

  await recordAudit({
    action: AUDIT_ACTIONS.SESSION_REVOKED,
    outcome: 'success',
    req,
    actor: req.user._id,
    actorRole: req.user.role,
    targetUser: req.user._id,
    targetType: 'session',
    targetId: id,
    sessionId: id,
    description: current ? 'User revoked their current session' : 'User revoked one of their sessions',
    metadata: { revokedSessions: revoked, currentSession: current },
  });

  res.status(200).json({ success: true, message: 'Session revoked', data: { sessionId: id, current } });
});

// DELETE /api/auth/sessions - revoke every session of the caller (all devices)
const revokeAllSessions = asyncHandler(async (req, res) => {
  const revoked = await sessionStore.revokeSessions({ user: req.user._id }, 'session_revoked_all');
  clearAuthCookies(res);

  await recordAudit({
    action: AUDIT_ACTIONS.SESSION_REVOKED_ALL,
    outcome: 'success',
    req,
    actor: req.user._id,
    actorRole: req.user.role,
    targetUser: req.user._id,
    targetType: 'session',
    description: 'User signed out of all devices',
    metadata: { revokedSessions: revoked },
  });

  res.status(200).json({ success: true, message: 'All sessions revoked', data: { revoked } });
});

module.exports = { refresh, logout, listSessions, revokeSession, revokeAllSessions };

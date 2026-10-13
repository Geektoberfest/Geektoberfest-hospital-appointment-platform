const mongoose = require('mongoose');

/**
 * One document per issued refresh token.
 *
 * Terms used throughout the auth layer:
 * - `sessionId` identifies a single signed-in device/session. It is embedded in
 *   the access token as the `sid` claim so the middleware can check revocation.
 * - `familyId` identifies the lineage of rotated tokens for one sign-in. It is
 *   revoked as a unit when token reuse (replay) is detected.
 *
 * Only the SHA-256 hash of a refresh token is stored. The raw value only ever
 * lives in the caller's HttpOnly cookie and is never written to the database,
 * returned in a JSON response, or logged.
 *
 * Rotation is made atomic by the partial unique index on `sessionId`: at most
 * one document per session can be active (`revokedAt: null`), so two concurrent
 * refresh calls can never leave two live refresh tokens for the same device.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true, trim: true },
    familyId: { type: String, required: true, trim: true },
    tokenHash: { type: String, required: true, trim: true },
    // Hash of the token that replaced this one during rotation (never the raw value).
    replacedByHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '', trim: true, maxlength: 40 },
    sessionStartedAt: { type: Date, required: true, default: Date.now },
    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    // Minimal device context so users can recognise their own sessions.
    userAgent: { type: String, default: '', maxlength: 200 },
    ip: { type: String, default: '', maxlength: 45 },
  },
  { timestamps: true }
);

// Exactly one active token per session - the concurrency guarantee for rotation.
refreshTokenSchema.index({ sessionId: 1 }, { unique: true, partialFilterExpression: { revokedAt: null } });
// Rotation lookup by hash; also blocks duplicate token records.
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
// List a user's active sessions without scanning revoked/expired rows.
refreshTokenSchema.index({ user: 1, revokedAt: 1, expiresAt: 1 });
// Revoke a whole token family when reuse is detected.
refreshTokenSchema.index({ familyId: 1, revokedAt: 1 });
// Expired rows are cleaned up 7 days later so recent replay attempts stay auditable.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

// Never expose hashes or family identifiers through an accidental res.json(doc).
refreshTokenSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.tokenHash;
    delete ret.replacedByHash;
    delete ret.familyId;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);

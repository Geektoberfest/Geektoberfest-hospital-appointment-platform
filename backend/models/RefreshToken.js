const mongoose = require('mongoose');

/**
 * One document per issued refresh token. Tokens that share a `family` belong to
 * the same login session (one device). Rotation marks the old token as `usedAt`
 * and issues a new one in the same family; reusing a `usedAt` token means the
 * cookie was stolen, so the whole family is revoked.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    family: { type: String, required: true, index: true },
    // SHA-256 of the raw token; the raw value only ever lives in the HTTP-only cookie.
    tokenHash: { type: String, required: true, unique: true },
    deviceName: { type: String, trim: true, default: '', maxlength: 255 },
    ip: { type: String, trim: true, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Mongo removes expired documents automatically.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ family: 1, revokedAt: 1, usedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);

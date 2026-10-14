const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Ensure test environment variables
process.env.JWT_SECRET = 'test-secret-key-12345678901234567890';
process.env.ACCESS_TOKEN_EXPIRES_IN = '15m';
process.env.REFRESH_TOKEN_DAYS = '7';

const generateToken = require('../utils/generateToken');
const { hashToken } = require('../utils/session');
const { recordAudit } = require('../utils/auditLog');
const { authorize } = require('../middlewares/roleMiddleware');
const RefreshToken = require('../models/RefreshToken');
const AuditLog = require('../models/AuditLog');

test('generateToken embeds id and sid in JWT payload', () => {
  const userId = '60d5ec49f1b2c8b1f8e4e1a1';
  const sessionId = 'test-family-uuid-1234';

  const token = generateToken(userId, sessionId);
  assert.ok(typeof token === 'string' && token.length > 0);

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.id, userId);
  assert.equal(decoded.sid, sessionId);
});

test('generateToken throws if JWT_SECRET is missing', () => {
  const originalSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;

  assert.throws(
    () => generateToken('user123', 'session123'),
    /JWT_SECRET is not defined/
  );

  process.env.JWT_SECRET = originalSecret;
});

test('hashToken produces deterministic SHA-256 hex digest', () => {
  const token = 'sample-raw-refresh-token-value';
  const hash1 = hashToken(token);
  const hash2 = hashToken(token);

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64); // SHA-256 hex length
  assert.notEqual(hashToken('token-a'), hashToken('token-b'));
});

test('RefreshToken model schema validation and fields', () => {
  assert.ok(RefreshToken.schema.paths.user);
  assert.ok(RefreshToken.schema.paths.family);
  assert.ok(RefreshToken.schema.paths.tokenHash);
  assert.ok(RefreshToken.schema.paths.deviceName);
  assert.ok(RefreshToken.schema.paths.ip);
  assert.ok(RefreshToken.schema.paths.usedAt);
  assert.ok(RefreshToken.schema.paths.revokedAt);
  assert.ok(RefreshToken.schema.paths.expiresAt);
});

test('AuditLog model schema validation and fields', () => {
  assert.ok(AuditLog.schema.paths.actor);
  assert.ok(AuditLog.schema.paths.actorRole);
  assert.ok(AuditLog.schema.paths.action);
  assert.ok(AuditLog.schema.paths.outcome);
  assert.ok(AuditLog.schema.paths.targetType);
  assert.ok(AuditLog.schema.paths.targetId);
  assert.ok(AuditLog.schema.paths.ip);
  assert.ok(AuditLog.schema.paths.details);
});

test('recordAudit swallows errors without throwing if database unavailable', async () => {
  const originalCreate = AuditLog.create;
  AuditLog.create = async () => {
    throw new Error('Database connection failed');
  };
  try {
    await assert.doesNotReject(async () => {
      await recordAudit({
        action: 'test.action',
        outcome: 'success',
        details: { info: 'test' },
      });
    });
  } finally {
    AuditLog.create = originalCreate;
  }
});

test('roleMiddleware authorize grants access when role matches', (t, done) => {
  const middleware = authorize('admin', 'doctor');
  const req = { user: { role: 'admin' } };
  const res = {};
  middleware(req, res, (err) => {
    assert.equal(err, undefined);
    done();
  });
});

test('roleMiddleware authorize denies access with 403 when role does not match', (t, done) => {
  const originalCreate = AuditLog.create;
  AuditLog.create = async () => ({});
  const middleware = authorize('admin');
  const req = {
    user: { role: 'patient' },
    method: 'GET',
    originalUrl: '/api/admin/audit-logs',
  };
  const res = {};
  middleware(req, res, (err) => {
    AuditLog.create = originalCreate;
    assert.ok(err);
    assert.equal(err.status, 403);
    assert.match(err.message, /Role 'patient' is not allowed/);
    done();
  });
});

test('roleMiddleware authorize denies access with 401 when unauthenticated', (t, done) => {
  const middleware = authorize('admin');
  const req = {};
  const res = {};
  middleware(req, res, (err) => {
    assert.ok(err);
    assert.equal(err.status, 401);
    done();
  });
});

process.env.JWT_SECRET = 'test_secret_for_session_tests_1234567890';
process.env.NODE_ENV = 'test';
delete process.env.REFRESH_TOKEN_GRACE_MS;

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const RefreshToken = require('../models/RefreshToken');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Doctor = require('../models/Doctor');
const tokenUtils = require('../utils/tokenUtils');
const generateToken = require('../utils/generateToken');
const { recordAudit } = require('../utils/audit');
const { sanitizeMetadata } = require('../utils/redact');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/roleMiddleware');
const { requireCsrf } = require('../middlewares/requestContext');
const { errorHandler, HttpError } = require('../middlewares/errorHandler');
const authController = require('../controllers/authController');
const sessionController = require('../controllers/sessionController');
const userController = require('../controllers/userController');

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439022';
const ADMIN_ID = '507f1f77bcf86cd799439033';
const SESSION_ID = '3f6c1f8e-0d2b-4a9c-9f7a-1b2c3d4e5f60';
const OTHER_SESSION_ID = '4a7d2f9f-1e3c-4b8d-8e6b-2c3d4e5f6a71';
const FAMILY_ID = '9c1b2a3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d';
const TOKEN_HASH = 'a'.repeat(64);
const MODERN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';

/** Build a fake Express request with a working `get()`. */
const makeReq = ({ headers: headerOverrides = {}, ...overrides } = {}) => {
  const headers = { 'user-agent': MODERN_UA, ...headerOverrides };
  const req = {
    method: 'POST',
    originalUrl: '/api/auth/refresh',
    requestId: 'test-request-id',
    ip: '127.0.0.1',
    cookies: {},
    ...overrides,
    headers,
  };
  req.get = (name) => headers[String(name).toLowerCase()];
  return req;
};

/** Run a handler through the real error handler and capture status/body/cookies. */
const execute = async (handler, req) => {
  let statusCode = 200;
  let payload = null;
  const setCookies = [];
  const clearedCookies = [];

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      payload = data;
      return res;
    },
    cookie(name, value, options) {
      setCookies.push({ name, value, options });
      return res;
    },
    clearCookie(name, options) {
      clearedCookies.push({ name, options });
      return res;
    },
    setHeader() {
      return res;
    },
  };

  const error = await new Promise((resolve) => {
    const next = (err) => resolve(err || null);
    Promise.resolve(handler(req, res, next))
      .then(() => resolve(null))
      .catch(resolve);
  });

  if (error) errorHandler(error, req, res, () => {});
  return { status: statusCode, body: payload, error, setCookies, clearedCookies };
};

/** Capture audit writes; also keeps the tests from buffering against a missing DB. */
const captureAudits = (t) => {
  const created = [];
  const original = AuditLog.create;
  AuditLog.create = async (doc) => {
    created.push(doc);
    return doc;
  };
  t.after(() => {
    AuditLog.create = original;
  });
  return created;
};

/** Fire-and-forget audit writes need one tick to land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const activeToken = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439099',
  user: USER_ID,
  sessionId: SESSION_ID,
  familyId: FAMILY_ID,
  tokenHash: TOKEN_HASH,
  sessionStartedAt: new Date(Date.now() - 60_000),
  lastUsedAt: new Date(Date.now() - 1_000),
  expiresAt: new Date(Date.now() + 86_400_000),
  rotatedAt: null,
  revokedAt: null,
  revokedReason: '',
  userAgent: MODERN_UA,
  ip: '127.0.0.1',
  ...overrides,
});

const MODELS = { RefreshToken, AuditLog, User, Doctor };

const stubModels = (t, stubs) => {
  const originals = new Map();
  for (const [key, value] of Object.entries(stubs)) {
    const [modelName, method] = key.split('.');
    const model = MODELS[modelName];
    assert.ok(model, `unknown model in stub key ${key}`);
    originals.set(key, [model, method, model[method]]);
    model[method] = value;
  }
  t.after(() => {
    for (const [, [model, method, original]] of originals) model[method] = original;
  });
};

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

test('RefreshToken model enforces one active token per session and indexes lookups', () => {
  const indexes = RefreshToken.schema.indexes();

  const sessionIndex = indexes.find(([fields]) => fields.sessionId === 1 && Object.keys(fields).length === 1);
  assert.ok(sessionIndex, 'a sessionId index must exist');
  assert.equal(sessionIndex[1].unique, true);
  assert.deepEqual(sessionIndex[1].partialFilterExpression, { revokedAt: null });

  const hashIndex = indexes.find(([fields]) => fields.tokenHash === 1);
  assert.ok(hashIndex, 'a tokenHash index must exist');
  assert.equal(hashIndex[1].unique, true);

  assert.ok(
    indexes.some(([fields]) => fields.user === 1 && fields.revokedAt === 1 && fields.expiresAt === 1),
    'a user/revokedAt/expiresAt index must exist for session listing'
  );
  assert.ok(indexes.some(([fields]) => fields.familyId === 1), 'a familyId index must exist for family revocation');

  const ttlIndex = indexes.find(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds !== undefined);
  assert.ok(ttlIndex, 'expired refresh tokens must be cleaned up by a TTL index');

  for (const path of ['user', 'sessionId', 'familyId', 'tokenHash', 'replacedByHash', 'rotatedAt', 'revokedAt', 'revokedReason', 'sessionStartedAt', 'expiresAt']) {
    assert.ok(RefreshToken.schema.path(path), `RefreshToken.${path} must be defined`);
  }
});

test('RefreshToken serialization never exposes token hashes or family ids', () => {
  const doc = new RefreshToken({
    user: new mongoose.Types.ObjectId(USER_ID),
    sessionId: SESSION_ID,
    familyId: FAMILY_ID,
    tokenHash: TOKEN_HASH,
    replacedByHash: 'b'.repeat(64),
    sessionStartedAt: new Date(),
    expiresAt: new Date(Date.now() + 1000),
  });
  const json = doc.toJSON();
  assert.equal(json.tokenHash, undefined);
  assert.equal(json.familyId, undefined);
  assert.equal(json.replacedByHash, undefined);
  assert.equal(json.sessionId, SESSION_ID);
});

test('AuditLog model exposes the structured security-event fields', () => {
  for (const path of ['action', 'outcome', 'actor', 'actorRole', 'targetUser', 'targetType', 'targetId', 'sessionId', 'requestId', 'method', 'path', 'ip', 'userAgent', 'description', 'metadata']) {
    assert.ok(AuditLog.schema.path(path), `AuditLog.${path} must be defined`);
  }
  assert.deepEqual(AuditLog.OUTCOMES, ['success', 'failure', 'denied', 'error']);
  assert.ok(AuditLog.schema.indexes().some(([fields]) => fields.createdAt === -1));
});

// ---------------------------------------------------------------------------
// Token cryptography, cookies and access tokens
// ---------------------------------------------------------------------------

test('refresh tokens are random and only ever stored as a SHA-256 hash', () => {
  const raw = tokenUtils.generateRefreshTokenValue();
  assert.match(raw, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(raw, tokenUtils.generateRefreshTokenValue());

  const hash = tokenUtils.hashRefreshToken(raw);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, raw);
  assert.equal(tokenUtils.hashRefreshToken(raw), hash);

  assert.equal(tokenUtils.isValidRefreshTokenValue(raw), true);
  assert.equal(tokenUtils.isValidRefreshTokenValue('short'), false);
  assert.equal(tokenUtils.isValidRefreshTokenValue('a'.repeat(500)), false);
  assert.equal(tokenUtils.isValidRefreshTokenValue(undefined), false);
  assert.equal(tokenUtils.isValidRefreshTokenValue('has spaces and ünicode'), false);
});

test('refresh cookie is HttpOnly, scoped and production-safe', (t) => {
  const restore = {
    sameSite: process.env.REFRESH_COOKIE_SAMESITE,
    secure: process.env.REFRESH_COOKIE_SECURE,
    nodeEnv: process.env.NODE_ENV,
  };
  t.after(() => {
    process.env.NODE_ENV = restore.nodeEnv;
    if (restore.sameSite === undefined) delete process.env.REFRESH_COOKIE_SAMESITE;
    else process.env.REFRESH_COOKIE_SAMESITE = restore.sameSite;
    if (restore.secure === undefined) delete process.env.REFRESH_COOKIE_SECURE;
    else process.env.REFRESH_COOKIE_SECURE = restore.secure;
  });

  process.env.NODE_ENV = 'production';
  delete process.env.REFRESH_COOKIE_SAMESITE;
  delete process.env.REFRESH_COOKIE_SECURE;
  const prod = tokenUtils.refreshCookieOptions();
  assert.equal(prod.httpOnly, true);
  assert.equal(prod.secure, true);
  assert.equal(prod.sameSite, 'none'); // frontend and backend are on different sites
  assert.equal(prod.path, '/api/auth');
  assert.ok(prod.maxAge > 0);

  // SameSite=None without Secure would be rejected by browsers; never emit it.
  process.env.REFRESH_COOKIE_SAMESITE = 'none';
  process.env.REFRESH_COOKIE_SECURE = 'false';
  assert.equal(tokenUtils.refreshCookieOptions().secure, true);

  process.env.NODE_ENV = 'development';
  delete process.env.REFRESH_COOKIE_SAMESITE;
  delete process.env.REFRESH_COOKIE_SECURE;
  const dev = tokenUtils.refreshCookieOptions();
  assert.equal(dev.httpOnly, true);
  assert.equal(dev.secure, false);
  assert.equal(dev.sameSite, 'lax');

  // The CSRF double-submit cookie must be readable by our own JavaScript.
  assert.equal(tokenUtils.csrfCookieOptions().httpOnly, false);
});

test('setAuthCookies and clearAuthCookies manage both cookies', () => {
  const calls = { set: [], cleared: [] };
  const res = {
    cookie: (...args) => calls.set.push(args),
    clearCookie: (...args) => calls.cleared.push(args),
  };

  tokenUtils.setAuthCookies(res, { refreshToken: 'raw-refresh', csrfToken: 'csrf-value' });
  assert.equal(calls.set.length, 2);
  assert.deepEqual(calls.set.map((c) => c[0]).sort(), [tokenUtils.CSRF_COOKIE_NAME, tokenUtils.REFRESH_COOKIE_NAME].sort());
  assert.equal(calls.set.find((c) => c[0] === tokenUtils.REFRESH_COOKIE_NAME)[2].httpOnly, true);

  tokenUtils.clearAuthCookies(res);
  assert.deepEqual(calls.cleared.map((c) => c[0]).sort(), [tokenUtils.CSRF_COOKIE_NAME, tokenUtils.REFRESH_COOKIE_NAME].sort());
});

test('parseCookieHeader reads first-party cookies and survives malformed input', () => {
  assert.deepEqual(tokenUtils.parseCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(tokenUtils.parseCookieHeader('refresh_token=abc%2Fdef'), { refresh_token: 'abc/def' });
  assert.deepEqual(tokenUtils.parseCookieHeader('broken; =nope; ok=yes'), { ok: 'yes' });
  assert.deepEqual(tokenUtils.parseCookieHeader(''), {});
  assert.deepEqual(tokenUtils.parseCookieHeader(undefined), {});
});

test('access tokens are short lived and bound to one session', () => {
  const token = generateToken(USER_ID, SESSION_ID);
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.id, USER_ID);
  assert.equal(decoded.sid, SESSION_ID);

  const ttlMinutes = (decoded.exp - decoded.iat) / 60;
  assert.ok(ttlMinutes > 0 && ttlMinutes <= 15, `access token ttl was ${ttlMinutes} minutes`);
  assert.equal(decoded.refreshToken, undefined);

  assert.throws(() => generateToken(USER_ID), /sessionId is required/);
});

// ---------------------------------------------------------------------------
// Authorization middleware
// ---------------------------------------------------------------------------

test('protect rejects missing, malformed, legacy and revoked sessions', async (t) => {
  let existsQuery = null;
  let sessionActive = true;
  const user = { _id: USER_ID, role: 'patient', isActive: true, name: 'Test Patient' };

  stubModels(t, {
    'User.findById': async () => user,
    'RefreshToken.exists': async (query) => {
      existsQuery = query;
      return sessionActive ? { _id: '1' } : null;
    },
  });

  const authorization = `Bearer ${generateToken(USER_ID, SESSION_ID)}`;

  const missing = await execute(protect, makeReq({ method: 'GET', originalUrl: '/api/auth/me', headers: {} }));
  assert.equal(missing.status, 401);
  assert.match(missing.body.message, /token missing/i);

  const malformed = await execute(protect, makeReq({ method: 'GET', headers: { authorization: 'Bearer not-a-jwt' } }));
  assert.equal(malformed.status, 401);
  assert.match(malformed.body.message, /invalid or expired/i);

  // Tokens minted before session tracking existed must not be trusted until they expire.
  const legacyToken = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const legacy = await execute(protect, makeReq({ method: 'GET', headers: { authorization: `Bearer ${legacyToken}` } }));
  assert.equal(legacy.status, 401);
  assert.match(legacy.body.message, /session context/i);

  const okReq = makeReq({ method: 'GET', headers: { authorization } });
  const ok = await execute(protect, okReq);
  assert.equal(ok.error, null);
  assert.equal(okReq.user, user);
  assert.equal(okReq.sessionId, SESSION_ID);

  // The session is validated against authoritative server state on every request.
  assert.equal(existsQuery.sessionId, SESSION_ID);
  assert.equal(existsQuery.revokedAt, null);
  assert.ok(existsQuery.expiresAt.$gt instanceof Date);

  sessionActive = false;
  const revoked = await execute(protect, makeReq({ method: 'GET', headers: { authorization } }));
  assert.equal(revoked.status, 401);
  assert.match(revoked.body.message, /revoked or expired/i);
});

test('protect refuses deactivated accounts with 403', async (t) => {
  stubModels(t, {
    'User.findById': async () => ({ _id: USER_ID, role: 'patient', isActive: false }),
    'RefreshToken.exists': async () => ({ _id: '1' }),
  });
  const result = await execute(protect, makeReq({ method: 'GET', headers: { authorization: `Bearer ${generateToken(USER_ID, SESSION_ID)}` } }));
  assert.equal(result.status, 403);
  assert.match(result.body.message, /deactivated/i);
});

test('authorize denies role mismatches and audits the denial without secrets', async (t) => {
  const audits = captureAudits(t);
  const req = makeReq({
    method: 'GET',
    originalUrl: '/api/admin/audit-logs?secret=abc',
    baseUrl: '/api/admin',
    path: '/audit-logs',
    user: { _id: USER_ID, role: 'patient' },
    sessionId: SESSION_ID,
  });

  const result = await execute(authorize('admin'), req);
  assert.equal(result.status, 403);
  assert.match(result.body.message, /not allowed/i);

  await flush();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'rbac.access.denied');
  assert.equal(audits[0].outcome, 'denied');
  assert.equal(String(audits[0].actor), USER_ID);
  assert.equal(audits[0].actorRole, 'patient');
  assert.deepEqual(audits[0].metadata.requiredRoles, ['admin']);
  // Query strings are dropped so a token in the URL can never be persisted.
  assert.equal(audits[0].path, '/api/admin/audit-logs');

  const serialized = JSON.stringify(audits[0]);
  assert.doesNotMatch(serialized, /Bearer|password|tokenHash|refresh_token/);

  await flush();
  const allowed = await execute(authorize('admin'), makeReq({ user: { _id: USER_ID, role: 'admin' } }));
  assert.equal(allowed.error, null);
});

test('requireCsrf blocks cookie-authenticated writes without a matching header', async (t) => {
  const audits = captureAudits(t);

  const missingHeader = await execute(requireCsrf, makeReq({ cookies: { [tokenUtils.CSRF_COOKIE_NAME]: 'csrf-value' } }));
  assert.equal(missingHeader.status, 403);
  assert.match(missingHeader.body.message, /CSRF/i);

  const mismatch = await execute(
    requireCsrf,
    makeReq({ headers: { 'x-csrf-token': 'csrf-value-different' }, cookies: { [tokenUtils.CSRF_COOKIE_NAME]: 'csrf-value' } })
  );
  assert.equal(mismatch.status, 403);

  const okReq = makeReq({ headers: { 'x-csrf-token': 'csrf-value' }, cookies: { [tokenUtils.CSRF_COOKIE_NAME]: 'csrf-value' } });
  const ok = await execute(requireCsrf, okReq);
  assert.equal(ok.error, null);

  await flush();
  assert.ok(audits.some((a) => a.action === 'csrf.denied' && a.outcome === 'denied'));
});

// ---------------------------------------------------------------------------
// Login / registration sessions
// ---------------------------------------------------------------------------

test('login establishes a distinct session per device and stores only the hash', async (t) => {
  const audits = captureAudits(t);
  const created = [];
  const user = {
    _id: USER_ID,
    role: 'patient',
    isActive: true,
    name: 'Test Patient',
    comparePassword: async () => true,
  };

  stubModels(t, {
    'User.findOne': () => ({ select: async () => user }),
    'RefreshToken.create': async (doc) => {
      created.push(doc);
      return doc;
    },
  });

  const first = await execute(
    authController.login,
    makeReq({ method: 'POST', originalUrl: '/api/auth/login', body: { email: 'patient@example.com', password: 'secret123' } })
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.ok(first.body.data.token);
  assert.equal(first.body.data.user, user);

  const cookie = first.setCookies.find((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME);
  assert.ok(cookie, 'login must set the refresh cookie');
  assert.equal(cookie.options.httpOnly, true);
  assert.ok(first.setCookies.some((c) => c.name === tokenUtils.CSRF_COOKIE_NAME));

  assert.equal(created.length, 1);
  assert.match(created[0].sessionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(created[0].sessionId, created[0].familyId);
  assert.equal(created[0].tokenHash, tokenUtils.hashRefreshToken(cookie.value));
  // The raw refresh token is never stored and never returned in JSON.
  assert.equal(JSON.stringify(created[0]).includes(cookie.value), false);
  assert.equal(JSON.stringify(first.body).includes(cookie.value), false);
  assert.equal(first.body.data.refreshToken, undefined);

  const decoded = jwt.verify(first.body.data.token, process.env.JWT_SECRET);
  assert.equal(decoded.sid, created[0].sessionId);
  assert.equal(audits[0].action, 'auth.login.success');

  // A second login is a separate session.
  const second = await execute(
    authController.login,
    makeReq({ method: 'POST', originalUrl: '/api/auth/login', body: { email: 'patient@example.com', password: 'secret123' } })
  );
  assert.equal(second.status, 200);
  assert.equal(created.length, 2);
  assert.notEqual(created[0].sessionId, created[1].sessionId);
});

test('failed login is rejected, audited and creates no session', async (t) => {
  const audits = captureAudits(t);
  let created = 0;

  stubModels(t, {
    'User.findOne': () => ({ select: async () => ({ _id: USER_ID, role: 'patient', isActive: true, comparePassword: async () => false }) }),
    'RefreshToken.create': async (doc) => {
      created += 1;
      return doc;
    },
  });

  const result = await execute(
    authController.login,
    makeReq({ method: 'POST', originalUrl: '/api/auth/login', body: { email: 'patient@example.com', password: 'wrong-password' } })
  );

  assert.equal(result.status, 401);
  assert.equal(result.body.success, false);
  assert.equal(result.body.message, 'Invalid email or password');
  assert.equal(created, 0);
  assert.equal(result.setCookies.length, 0);
  assert.equal(audits[0].action, 'auth.login.failed');
  assert.equal(audits[0].outcome, 'failure');
  // The attempted email is not recorded.
  assert.equal(JSON.stringify(audits[0]).includes('patient@example.com'), false);
});

test('registration also establishes a session and sets the auth cookies', async (t) => {
  captureAudits(t);
  const created = [];

  stubModels(t, {
    'User.findOne': async () => null,
    'User.create': async (doc) => ({ _id: USER_ID, role: 'patient', isActive: true, ...doc }),
    'RefreshToken.create': async (doc) => {
      created.push(doc);
      return doc;
    },
  });

  const result = await execute(
    authController.register,
    makeReq({
      method: 'POST',
      originalUrl: '/api/auth/register',
      body: { name: 'New Patient', email: 'new@example.com', password: 'secret123', role: 'patient' },
    })
  );

  assert.equal(result.status, 201);
  assert.equal(created.length, 1);
  const cookie = result.setCookies.find((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME);
  assert.ok(cookie);
  assert.equal(created[0].tokenHash, tokenUtils.hashRefreshToken(cookie.value));
});

// ---------------------------------------------------------------------------
// Refresh rotation
// ---------------------------------------------------------------------------

test('a valid refresh token rotates: claim is atomic, cookie rotates, hash is stored', async (t) => {
  const audits = captureAudits(t);
  const created = [];
  let claimFilter = null;
  let claimUpdate = null;
  let replacementWrite = null;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async (filter, update) => {
      claimFilter = filter;
      claimUpdate = update;
      return activeToken();
    },
    'RefreshToken.create': async (doc) => {
      created.push(doc);
      return doc;
    },
    'RefreshToken.updateOne': async (filter, update) => {
      replacementWrite = { filter, update };
      return { modifiedCount: 1 };
    },
    'User.findById': async () => ({ _id: USER_ID, role: 'patient', isActive: true }),
  });

  const presented = tokenUtils.generateRefreshTokenValue();
  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: presented } })
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.ok(result.body.data.token);

  // The claim is an atomic conditional update - this is what makes replay impossible.
  assert.equal(claimFilter.tokenHash, tokenUtils.hashRefreshToken(presented));
  assert.equal(claimFilter.revokedAt, null);
  assert.ok(claimFilter.expiresAt.$gt instanceof Date);
  assert.ok(claimUpdate.$set.revokedAt instanceof Date);
  assert.equal(claimUpdate.$set.revokedReason, 'rotated');

  // Successor token: new random value, stored as a hash, same session and family.
  assert.equal(created.length, 1);
  assert.equal(created[0].sessionId, SESSION_ID);
  assert.equal(created[0].familyId, FAMILY_ID);
  assert.match(created[0].tokenHash, /^[0-9a-f]{64}$/);

  const cookie = result.setCookies.find((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME);
  assert.ok(cookie, 'a rotated refresh cookie must be set');
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.path, '/api/auth');
  assert.match(cookie.value, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(cookie.value, presented);
  assert.equal(created[0].tokenHash, tokenUtils.hashRefreshToken(cookie.value));
  assert.equal(JSON.stringify(created[0]).includes(cookie.value), false);
  assert.ok(result.setCookies.some((c) => c.name === tokenUtils.CSRF_COOKIE_NAME), 'the CSRF secret rotates too');

  assert.equal(replacementWrite.update.$set.replacedByHash, created[0].tokenHash);

  // The body carries an access token bound to the session and no refresh token.
  const decoded = jwt.verify(result.body.data.token, process.env.JWT_SECRET);
  assert.equal(decoded.sid, SESSION_ID);
  assert.equal(JSON.stringify(result.body).includes(cookie.value), false);

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'auth.refresh.success');
});

test('a missing or malformed refresh cookie is rejected and cleared', async (t) => {
  const audits = captureAudits(t);
  let claims = 0;
  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => {
      claims += 1;
      return null;
    },
  });

  const missing = await execute(sessionController.refresh, makeReq({ cookies: {} }));
  assert.equal(missing.status, 401);
  assert.equal(missing.body.success, false);
  assert.ok(missing.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));

  const malformed = await execute(sessionController.refresh, makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: 'not-a-real-token' } }));
  assert.equal(malformed.status, 401);

  // Malformed values never reach the database.
  assert.equal(claims, 0);
  await flush();
  assert.equal(audits.filter((a) => a.action === 'auth.refresh.failed').length, 2);
});

test('an expired refresh token is rejected without revoking the session', async (t) => {
  const audits = captureAudits(t);
  let revocations = 0;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => null,
    'RefreshToken.findOne': async () => activeToken({ expiresAt: new Date(Date.now() - 1000) }),
    'RefreshToken.updateMany': async () => {
      revocations += 1;
      return { modifiedCount: 0 };
    },
  });

  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: tokenUtils.generateRefreshTokenValue() } })
  );

  assert.equal(result.status, 401);
  assert.match(result.body.message, /expired/i);
  assert.equal(result.body.stack, undefined);
  assert.ok(result.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));
  // A stale cookie must not be usable as a denial-of-service switch for the real session.
  assert.equal(revocations, 0);
  await flush();
  assert.ok(audits.some((a) => a.action === 'auth.refresh.expired'));
});

test('replaying a rotated token outside the grace window revokes the session', async (t) => {
  const audits = captureAudits(t);
  let revocation = null;
  const rotatedAt = new Date(Date.now() - 5 * 60_000);

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => null,
    'RefreshToken.findOne': async () => activeToken({ revokedAt: rotatedAt, rotatedAt, revokedReason: 'rotated' }),
    'RefreshToken.updateMany': async (filter, update) => {
      revocation = { filter, update };
      return { modifiedCount: 1 };
    },
  });

  const presented = tokenUtils.generateRefreshTokenValue();
  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: presented } })
  );

  assert.equal(result.status, 401);
  assert.match(result.body.message, /reuse detected/i);
  assert.equal(result.body.stack, undefined);
  assert.equal(JSON.stringify(result.body).includes(presented), false);
  assert.ok(result.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));

  assert.ok(revocation, 'the compromised session must be revoked');
  assert.equal(revocation.filter.sessionId, SESSION_ID);
  assert.equal(revocation.filter.revokedAt, null);
  assert.equal(revocation.update.$set.revokedReason, 'rotation_reuse_detected');

  await flush();
  const reuse = audits.find((a) => a.action === 'auth.refresh.reuse_detected');
  assert.ok(reuse, 'reuse must be audited');
  assert.equal(reuse.outcome, 'failure');
  assert.equal(JSON.stringify(reuse).includes(presented), false);
});

test('a concurrent duplicate inside the grace window is tolerated without a new token chain', async (t) => {
  const audits = captureAudits(t);
  const restoreGrace = process.env.REFRESH_TOKEN_GRACE_MS;
  process.env.REFRESH_TOKEN_GRACE_MS = '30000';
  t.after(() => {
    if (restoreGrace === undefined) delete process.env.REFRESH_TOKEN_GRACE_MS;
    else process.env.REFRESH_TOKEN_GRACE_MS = restoreGrace;
  });

  const rotatedAt = new Date(Date.now() - 500);
  const consumed = activeToken({ revokedAt: rotatedAt, rotatedAt, revokedReason: 'rotated' });
  const successor = activeToken({ _id: '507f1f77bcf86cd799439088', tokenHash: 'b'.repeat(64) });
  let revocations = 0;
  let created = 0;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => null,
    // First lookup is by tokenHash (the consumed token), second by sessionId (the live successor).
    'RefreshToken.findOne': async (filter) => (filter.tokenHash ? consumed : successor),
    'RefreshToken.updateMany': async () => {
      revocations += 1;
      return { modifiedCount: 1 };
    },
    'RefreshToken.create': async (doc) => {
      created += 1;
      return doc;
    },
    'User.findById': async () => ({ _id: USER_ID, role: 'patient', isActive: true }),
  });

  const presented = tokenUtils.generateRefreshTokenValue();
  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: presented } })
  );

  assert.equal(result.status, 200);
  assert.ok(result.body.data.token);
  // The still-active session is not destroyed and no second token chain is created.
  assert.equal(revocations, 0);
  assert.equal(created, 0);
  // The consumed token's raw successor value can never be re-disclosed, so no new cookie is set.
  assert.equal(result.setCookies.length, 0);
  assert.equal(JSON.stringify(result.body).includes(presented), false);

  const decoded = jwt.verify(result.body.data.token, process.env.JWT_SECRET);
  assert.equal(decoded.sid, SESSION_ID);

  await flush();
  const tolerated = audits.find((a) => a.action === 'auth.refresh.concurrent_tolerated');
  assert.ok(tolerated, 'the tolerated duplicate must be auditable');
  assert.equal(tolerated.metadata.issuedNewRefresh, false);
  assert.equal(tolerated.metadata.graceMs, 30000);
});

test('the grace window never tolerates a replay when there is no live successor', async (t) => {
  captureAudits(t);
  const restoreGrace = process.env.REFRESH_TOKEN_GRACE_MS;
  process.env.REFRESH_TOKEN_GRACE_MS = '30000';
  t.after(() => {
    if (restoreGrace === undefined) delete process.env.REFRESH_TOKEN_GRACE_MS;
    else process.env.REFRESH_TOKEN_GRACE_MS = restoreGrace;
  });

  const rotatedAt = new Date(Date.now() - 500);
  let revocations = 0;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => null,
    'RefreshToken.findOne': async (filter) => (filter.tokenHash ? activeToken({ revokedAt: rotatedAt, rotatedAt, revokedReason: 'rotated' }) : null),
    'RefreshToken.updateMany': async () => {
      revocations += 1;
      return { modifiedCount: 1 };
    },
  });

  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: tokenUtils.generateRefreshTokenValue() } })
  );

  assert.equal(result.status, 401);
  assert.equal(revocations, 1);
});

test('disabling the grace window makes every replay revoke the session', async (t) => {
  captureAudits(t);
  const restoreGrace = process.env.REFRESH_TOKEN_GRACE_MS;
  process.env.REFRESH_TOKEN_GRACE_MS = '0';
  t.after(() => {
    if (restoreGrace === undefined) delete process.env.REFRESH_TOKEN_GRACE_MS;
    else process.env.REFRESH_TOKEN_GRACE_MS = restoreGrace;
  });

  const rotatedAt = new Date(Date.now() - 10);
  let revocations = 0;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => null,
    'RefreshToken.findOne': async (filter) => (filter.tokenHash ? activeToken({ revokedAt: rotatedAt, rotatedAt, revokedReason: 'rotated' }) : activeToken({ tokenHash: 'b'.repeat(64) })),
    'RefreshToken.updateMany': async () => {
      revocations += 1;
      return { modifiedCount: 1 };
    },
    'User.findById': async () => ({ _id: USER_ID, role: 'patient', isActive: true }),
  });

  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: tokenUtils.generateRefreshTokenValue() } })
  );

  assert.equal(result.status, 401);
  assert.equal(revocations, 1);
});

test('a losing concurrent rotation cannot create a second token chain', async (t) => {
  const audits = captureAudits(t);

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => activeToken(),
    // The partial unique index on sessionId rejects a second live token for the session.
    'RefreshToken.create': async () => {
      const err = new Error('E11000 duplicate key error collection: refreshtokens index: sessionId_1');
      err.code = 11000;
      throw err;
    },
    'User.findById': async () => ({ _id: USER_ID, role: 'patient', isActive: true }),
  });

  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: tokenUtils.generateRefreshTokenValue() } })
  );

  assert.equal(result.status, 401);
  assert.equal(result.body.success, false);
  assert.match(result.body.message, /already completed elsewhere/i);
  // No cookie is issued, so the winning request's session keeps working.
  assert.equal(result.setCookies.length, 0);
  assert.equal(result.clearedCookies.length, 0);

  await flush();
  assert.ok(audits.some((a) => a.action === 'auth.refresh.concurrent_conflict'));
  assert.equal(audits.some((a) => a.action === 'auth.refresh.reuse_detected'), false);
});

test('refreshing after a revoked session is rejected without a second revocation', async (t) => {
  const audits = captureAudits(t);
  let revocations = 0;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => null,
    'RefreshToken.findOne': async () => activeToken({ revokedAt: new Date(), revokedReason: 'session_revoked_all' }),
    'RefreshToken.updateMany': async () => {
      revocations += 1;
      return { modifiedCount: 1 };
    },
  });

  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: tokenUtils.generateRefreshTokenValue() } })
  );

  assert.equal(result.status, 401);
  assert.match(result.body.message, /revoked/i);
  assert.equal(revocations, 0);
  await flush();
  assert.ok(audits.some((a) => a.action === 'auth.refresh.failed' && a.outcome === 'denied'));
});

test('a refresh for a deactivated account revokes the session and fails closed', async (t) => {
  captureAudits(t);
  let revocations = 0;

  stubModels(t, {
    'RefreshToken.findOneAndUpdate': async () => activeToken(),
    'User.findById': async () => ({ _id: USER_ID, role: 'patient', isActive: false }),
    'RefreshToken.updateMany': async () => {
      revocations += 1;
      return { modifiedCount: 2 };
    },
  });

  const result = await execute(
    sessionController.refresh,
    makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: tokenUtils.generateRefreshTokenValue() } })
  );

  assert.equal(result.status, 401);
  assert.equal(revocations, 1);
  assert.ok(result.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const chainable = (rows) => {
  const chain = {
    select: () => chain,
    sort: () => chain,
    lean: async () => rows,
  };
  return chain;
};

test('a user lists only their own sessions and never sees token material', async (t) => {
  let listFilter = null;
  const rows = [
    {
      _id: 'x',
      sessionId: SESSION_ID,
      sessionStartedAt: new Date('2026-10-13T09:00:00Z'),
      lastUsedAt: new Date('2026-10-13T09:30:00Z'),
      expiresAt: new Date('2026-11-12T09:00:00Z'),
      userAgent: MODERN_UA,
      ip: '10.0.0.1',
    },
    {
      _id: 'y',
      sessionId: OTHER_SESSION_ID,
      sessionStartedAt: new Date('2026-10-12T09:00:00Z'),
      lastUsedAt: null,
      expiresAt: new Date('2026-11-11T09:00:00Z'),
      userAgent: 'curl/8.0',
      ip: '',
    },
  ];

  stubModels(t, {
    'RefreshToken.find': (filter) => {
      listFilter = filter;
      return chainable(rows);
    },
  });

  const req = makeReq({ method: 'GET', originalUrl: '/api/auth/sessions', user: { _id: USER_ID, role: 'patient' }, sessionId: SESSION_ID });
  const result = await execute(sessionController.listSessions, req);

  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 2);

  // Scoped to the caller and only to sessions that are still usable.
  assert.equal(listFilter.user, USER_ID);
  assert.equal(listFilter.revokedAt, null);
  assert.ok(listFilter.expiresAt.$gt instanceof Date);

  const [current, other] = result.body.data;
  assert.equal(current._id, SESSION_ID);
  assert.equal(current.current, true);
  assert.equal(current.device, 'Chrome on Windows');
  assert.equal(other.current, false);
  assert.equal(other.device, 'Unknown device');

  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /tokenHash|familyId|replacedByHash/);
});

test('a user can revoke one of their own sessions but not another user\'s', async (t) => {
  const audits = captureAudits(t);
  let lookup = null;
  let revocation = null;

  stubModels(t, {
    'RefreshToken.findOne': async (filter) => {
      lookup = filter;
      return filter.sessionId === OTHER_SESSION_ID ? null : activeToken();
    },
    'RefreshToken.updateMany': async (filter, update) => {
      revocation = { filter, update };
      return { modifiedCount: 1 };
    },
  });

  const user = { _id: USER_ID, role: 'patient' };
  const own = await execute(
    sessionController.revokeSession,
    makeReq({ method: 'DELETE', originalUrl: `/api/auth/sessions/${OTHER_SESSION_ID}`, params: { id: OTHER_SESSION_ID }, user, sessionId: SESSION_ID })
  );

  // Another user's session simply does not exist for this caller.
  assert.equal(own.status, 404);
  assert.equal(lookup.user, USER_ID);

  const other = await execute(
    sessionController.revokeSession,
    makeReq({ method: 'DELETE', params: { id: SESSION_ID }, user, sessionId: SESSION_ID })
  );

  assert.equal(other.status, 200);
  assert.equal(revocation.filter.sessionId, SESSION_ID);
  assert.equal(revocation.filter.user, USER_ID);
  assert.equal(revocation.update.$set.revokedReason, 'session_revoked');
  // Revoking your own current session also clears the cookies.
  assert.ok(other.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));

  await flush();
  const revocationAudit = audits.find((a) => a.action === 'auth.session.revoked');
  assert.ok(revocationAudit);
  assert.equal(revocationAudit.targetId, SESSION_ID);
});

test('revokeSession validates the identifier before it touches the database', async (t) => {
  captureAudits(t);
  let lookups = 0;
  stubModels(t, {
    'RefreshToken.findOne': async () => {
      lookups += 1;
      return null;
    },
  });

  for (const id of ['not-a-session', '../../etc/passwd', '507f1f77bcf86cd799439011']) {
    const result = await execute(
      sessionController.revokeSession,
      makeReq({ method: 'DELETE', params: { id }, user: { _id: USER_ID, role: 'patient' }, sessionId: SESSION_ID })
    );
    assert.equal(result.status, 400, `expected 400 for id ${id}`);
  }
  assert.equal(lookups, 0);
});

test('a user can revoke all of their own sessions', async (t) => {
  const audits = captureAudits(t);
  let revocation = null;

  stubModels(t, {
    'RefreshToken.updateMany': async (filter, update) => {
      revocation = { filter, update };
      return { modifiedCount: 3 };
    },
  });

  const result = await execute(
    sessionController.revokeAllSessions,
    makeReq({ method: 'DELETE', user: { _id: USER_ID, role: 'admin' }, sessionId: SESSION_ID })
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.data.revoked, 3);
  assert.equal(revocation.filter.user, USER_ID);
  assert.equal(revocation.filter.revokedAt, null);
  assert.equal(revocation.update.$set.revokedReason, 'session_revoked_all');
  assert.ok(result.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));

  await flush();
  const audit = audits.find((a) => a.action === 'auth.session.revoked_all');
  assert.ok(audit);
  assert.equal(audit.actorRole, 'admin');
});

test('logout revokes the presented session, clears cookies and stays idempotent', async (t) => {
  const audits = captureAudits(t);
  let revocation = null;

  stubModels(t, {
    'RefreshToken.findOne': async () => activeToken(),
    'RefreshToken.updateMany': async (filter, update) => {
      revocation = { filter, update };
      return { modifiedCount: 1 };
    },
  });

  const presented = tokenUtils.generateRefreshTokenValue();
  const result = await execute(sessionController.logout, makeReq({ cookies: { [tokenUtils.REFRESH_COOKIE_NAME]: presented } }));

  assert.equal(result.status, 200);
  assert.equal(result.body.data.sessionId, SESSION_ID);
  assert.equal(revocation.filter.sessionId, SESSION_ID);
  assert.equal(revocation.update.$set.revokedReason, 'logout');
  assert.ok(result.clearedCookies.some((c) => c.name === tokenUtils.REFRESH_COOKIE_NAME));
  assert.ok(result.clearedCookies.some((c) => c.name === tokenUtils.CSRF_COOKIE_NAME));

  await flush();
  assert.ok(audits.some((a) => a.action === 'auth.logout'));

  // Without a cookie the endpoint still succeeds so the client can always finish signing out.
  const noCookie = await execute(sessionController.logout, makeReq({ cookies: {} }));
  assert.equal(noCookie.status, 200);
  assert.equal(noCookie.body.data.sessionId, null);
});

// ---------------------------------------------------------------------------
// Privileged actions
// ---------------------------------------------------------------------------

test('administrative user changes are audited without personal data or values', async (t) => {
  const audits = captureAudits(t);
  let doctorSync = 0;
  const target = {
    _id: OTHER_USER_ID,
    role: 'doctor',
    isActive: true,
    name: 'Original Name',
    save: async () => target,
  };

  stubModels(t, {
    'User.findById': async () => target,
    'Doctor.updateOne': async () => {
      doctorSync += 1;
      return { modifiedCount: 1 };
    },
  });

  const result = await execute(
    userController.updateUser,
    makeReq({
      method: 'PUT',
      originalUrl: `/api/users/${OTHER_USER_ID}`,
      params: { id: OTHER_USER_ID },
      body: { name: 'Renamed Doctor', isActive: false },
      user: { _id: ADMIN_ID, role: 'admin' },
      sessionId: SESSION_ID,
    })
  );

  assert.equal(result.status, 200);
  assert.equal(doctorSync, 1);

  const audit = audits.find((a) => a.action === 'admin.user.updated');
  assert.ok(audit, 'admin updates must be audited');
  assert.equal(audit.outcome, 'success');
  assert.equal(String(audit.actor), ADMIN_ID);
  assert.equal(audit.actorRole, 'admin');
  assert.equal(String(audit.targetUser), OTHER_USER_ID);
  assert.deepEqual([...audit.metadata.fields].sort(), ['isActive', 'name']);
  // Field names are recorded; the submitted values are not.
  assert.equal(JSON.stringify(audit).includes('Renamed Doctor'), false);
});

test('deactivating a user is audited and revokes every session of that user', async (t) => {
  const audits = captureAudits(t);
  let revocation = null;
  const target = {
    _id: OTHER_USER_ID,
    role: 'patient',
    isActive: true,
    save: async () => target,
  };

  stubModels(t, {
    'User.findById': async () => target,
    'RefreshToken.updateMany': async (filter, update) => {
      revocation = { filter, update };
      return { modifiedCount: 2 };
    },
  });

  const result = await execute(
    userController.deactivateUser,
    makeReq({ method: 'DELETE', originalUrl: `/api/users/${OTHER_USER_ID}`, params: { id: OTHER_USER_ID }, user: { _id: ADMIN_ID, role: 'admin' } })
  );

  assert.equal(result.status, 200);
  assert.ok(revocation, 'deactivation must revoke the user\'s sessions');
  assert.equal(String(revocation.filter.user), OTHER_USER_ID);
  assert.equal(revocation.filter.revokedAt, null);
  assert.equal(revocation.update.$set.revokedReason, 'account_deactivated');

  const audit = audits.find((a) => a.action === 'admin.user.deactivated');
  assert.ok(audit, 'deactivation must be audited');
  assert.equal(audit.metadata.revokedSessions, 2);
});

// ---------------------------------------------------------------------------
// Audit safety
// ---------------------------------------------------------------------------

test('audit metadata redacts secrets and cannot be log-injected', () => {
  const sanitized = sanitizeMetadata({
    refreshToken: 'super-secret-value',
    password: 'hunter2',
    Authorization: 'Bearer abc.def.ghi',
    cookie: 'refresh_token=xyz',
    tokenHash: 'a'.repeat(64),
    csrfToken: 'csrf-value',
    nested: { apiKey: 'k', note: 'line1\nline2\r\n[FATAL] forged entry' },
    long: 'x'.repeat(500),
    count: 3,
    ok: true,
  });

  assert.equal(sanitized.refreshToken, '[redacted]');
  assert.equal(sanitized.password, '[redacted]');
  assert.equal(sanitized.Authorization, '[redacted]');
  assert.equal(sanitized.cookie, '[redacted]');
  assert.equal(sanitized.tokenHash, '[redacted]');
  assert.equal(sanitized.csrfToken, '[redacted]');
  assert.equal(sanitized.nested.apiKey, '[redacted]');
  assert.equal(sanitized.nested.note.includes('\n'), false);
  assert.match(sanitized.nested.note, /line1 line2 \[FATAL\] forged entry/);
  assert.ok(sanitized.long.length <= 301);
  assert.equal(sanitized.count, 3);
  assert.equal(sanitized.ok, true);
});

test('recordAudit reports persistence failures instead of claiming success', async (t) => {
  const originalCreate = AuditLog.create;
  const originalError = console.error;
  AuditLog.create = async () => {
    throw new Error('database unavailable');
  };
  console.error = () => {};
  t.after(() => {
    AuditLog.create = originalCreate;
    console.error = originalError;
  });

  const result = await recordAudit({ action: 'auth.login.success', req: makeReq({}) });
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
});

test('recordAudit stores no tokens, hashes or raw authorization headers', async (t) => {
  const audits = captureAudits(t);
  const req = makeReq({
    headers: { authorization: 'Bearer header-secret-token', cookie: 'refresh_token=raw-cookie-value' },
    user: { _id: USER_ID, role: 'admin' },
    sessionId: SESSION_ID,
  });

  const result = await recordAudit({
    action: 'auth.refresh.reuse_detected',
    outcome: 'failure',
    req,
    description: 'test event',
    metadata: { refreshToken: 'raw-refresh-value', accessToken: 'raw-access-value' },
  });

  assert.equal(result.ok, true);
  const serialized = JSON.stringify(audits[0]);
  for (const secret of ['header-secret-token', 'raw-cookie-value', 'raw-refresh-value', 'raw-access-value']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be persisted`);
  }
  assert.equal(audits[0].requestId, 'test-request-id');
  assert.deepEqual(audits[0].metadata, { refreshToken: '[redacted]', accessToken: '[redacted]' });
  assert.equal(new HttpError(403, 'x').status, 403);
});

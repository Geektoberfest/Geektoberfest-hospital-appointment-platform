process.env.JWT_SECRET = 'test_secret_for_rbac_tests_1234567890';
process.env.NODE_ENV = 'test';
process.env.CLIENT_URL = 'http://localhost:5173';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const AuditLog = require('../models/AuditLog');
const generateToken = require('../utils/generateToken');
const tokenUtils = require('../utils/tokenUtils');

const ADMIN_ID = '507f1f77bcf86cd799439011';
const PATIENT_ID = '507f1f77bcf86cd799439012';
const SESSION_ID = '3f6c1f8e-0d2b-4a9c-9f7a-1b2c3d4e5f60';

const audits = [];
const originals = {
  auditCreate: AuditLog.create,
  auditFind: AuditLog.find,
  auditCount: AuditLog.countDocuments,
  userFindById: User.findById,
  sessionExists: RefreshToken.exists,
};

let server;
let baseUrl;

const auditChain = (rows) => {
  const chain = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: async () => rows,
  };
  return chain;
};

const authorizedFetch = (path, { role = 'patient', method = 'GET', ...rest } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${generateToken(role === 'admin' ? ADMIN_ID : PATIENT_ID, SESSION_ID)}`,
      'Content-Type': 'application/json',
    },
    ...rest,
  });

test.before(async () => {
  // No database is required: every model call the auth path makes is stubbed,
  // while routing, middleware, CSRF, validation and controllers stay real.
  AuditLog.create = async (doc) => {
    audits.push(doc);
    return doc;
  };
  User.findById = async () => ({ _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' });
  RefreshToken.exists = async () => ({ _id: '1' });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  AuditLog.create = originals.auditCreate;
  AuditLog.find = originals.auditFind;
  AuditLog.countDocuments = originals.auditCount;
  User.findById = originals.userFindById;
  RefreshToken.exists = originals.sessionExists;
  if (server) server.close();
});

test('anonymous requests to admin-only endpoints get 401 in the standard envelope', async () => {
  const res = await fetch(`${baseUrl}/api/admin/audit-logs`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /token missing/i);
  assert.ok(res.headers.get('x-request-id'), 'responses must carry a correlation id');
});

test('an ordinary user cannot read the admin audit log and the denial is audited', async () => {
  const before = audits.length;
  const res = await authorizedFetch('/api/admin/audit-logs', { role: 'patient' });
  assert.equal(res.status, 403);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /not allowed/i);
  assert.equal(body.data, undefined);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const denial = audits.slice(before).find((a) => a.action === 'rbac.access.denied');
  assert.ok(denial, 'the denied attempt must be recorded');
  assert.equal(denial.outcome, 'denied');
  assert.equal(String(denial.actor), PATIENT_ID);
  assert.equal(denial.method, 'GET');
  assert.equal(denial.path, '/api/admin/audit-logs');
  assert.ok(denial.requestId);
});

test('a doctor is equally refused the audit trail', async () => {
  User.findById = async () => ({ _id: PATIENT_ID, role: 'doctor', isActive: true, name: 'Test Doctor' });
  const res = await authorizedFetch('/api/admin/audit-logs', { role: 'patient' });
  assert.equal(res.status, 403);
  User.findById = async () => ({ _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' });
});

test('an admin can page through audit logs and bad filters are rejected', async () => {
  User.findById = async () => ({ _id: ADMIN_ID, role: 'admin', isActive: true, name: 'Test Admin' });
  const rows = [
    {
      _id: '507f1f77bcf86cd799439099',
      action: 'auth.refresh.reuse_detected',
      outcome: 'failure',
      actor: PATIENT_ID,
      actorRole: 'patient',
      description: 'Refresh token reuse detected',
      createdAt: new Date().toISOString(),
    },
  ];
  AuditLog.find = () => auditChain(rows);
  AuditLog.countDocuments = async () => 1;

  const ok = await authorizedFetch('/api/admin/audit-logs?page=1&limit=10&outcome=failure', { role: 'admin' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.success, true);
  assert.equal(body.data.logs.length, 1);
  assert.equal(body.data.pagination.page, 1);
  assert.equal(body.data.pagination.limit, 10);
  assert.equal(body.data.pagination.total, 1);
  assert.equal(body.data.logs[0].action, 'auth.refresh.reuse_detected');

  // Query parameters cannot be abused to widen access or inject operators.
  const badOutcome = await authorizedFetch('/api/admin/audit-logs?outcome=whatever', { role: 'admin' });
  assert.equal(badOutcome.status, 400);

  const badActor = await authorizedFetch('/api/admin/audit-logs?actor=not-an-id', { role: 'admin' });
  assert.equal(badActor.status, 400);

  const badAction = await authorizedFetch('/api/admin/audit-logs?action=%%%', { role: 'admin' });
  assert.equal(badAction.status, 400);

  const injection = await authorizedFetch('/api/admin/audit-logs?search=.*%24ne', { role: 'admin' });
  assert.equal(injection.status, 400);

  User.findById = async () => ({ _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' });
});

test('revocation takes effect immediately for access tokens of a revoked session', async () => {
  User.findById = async () => ({ _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' });
  RefreshToken.exists = async () => null; // session revoked

  const res = await authorizedFetch('/api/auth/sessions');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.message, /revoked or expired/i);

  RefreshToken.exists = async () => ({ _id: '1' });
});

test('the cookie-authenticated refresh endpoint requires a CSRF header', async () => {
  const noCsrf = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${tokenUtils.CSRF_COOKIE_NAME}=csrf-value` },
  });
  assert.equal(noCsrf.status, 403);
  const body = await noCsrf.json();
  assert.match(body.message, /CSRF/i);
});

test('refresh with a valid CSRF pair but no refresh cookie answers 401 and clears cookies', async () => {
  const res = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${tokenUtils.CSRF_COOKIE_NAME}=csrf-value`,
      'X-CSRF-Token': 'csrf-value',
    },
  });
  assert.equal(res.status, 401);
  const raw = await res.text();
  assert.match(raw, /Refresh token missing/i);
  assert.doesNotMatch(raw, /at Object\.|node_modules|stack/);
});

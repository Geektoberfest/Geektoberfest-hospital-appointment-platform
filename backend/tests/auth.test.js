/**
 * Authentication and registration tests (issue #6), driven over HTTP against the real
 * Express application: routing, the auth rate limiter, the JSON body parser, the controllers,
 * the session/cookie helpers and the error envelope are all the production implementations.
 *
 * Only the database boundary is faked (an in-memory account store plus captured writes), so the
 * suite runs without MongoDB, Redis or a .env file. `User.findOne` hands back a real mongoose
 * document, which means `comparePassword`, the schema's email normalisation and the `toJSON`
 * password stripping are the genuine implementations rather than mocks.
 */

process.env.JWT_SECRET = 'test_secret_for_auth_tests_1234567890';
process.env.NODE_ENV = 'test';
process.env.CLIENT_URL = 'http://localhost:5173';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../server');
const User = require('../models/User');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const RefreshToken = require('../models/RefreshToken');
const AuditLog = require('../models/AuditLog');
const tokenUtils = require('../utils/tokenUtils');

const USER_ID = '507f1f77bcf86cd799439011';
const DEPARTMENT_ID = '507f1f77bcf86cd799439021';
const PASSWORD = 'CorrectHorse1';
const BCRYPT_COST = 10; // the cost the User model's pre-save hook uses

const MODELS = { User, Doctor, Department, RefreshToken, AuditLog };

// ---------------------------------------------------------------------------
// Test doubles for the database boundary
// ---------------------------------------------------------------------------

/** In-memory stand-ins for the collections this suite touches. */
let accounts; // lowercased email -> User document
let createdUsers; // every payload handed to User.create
let createdDoctors; // every payload handed to Doctor.create
let deletedUsers; // every filter handed to User.deleteOne
let sessions; // refresh-token documents written by the session store
let audits; // audit documents written by recordAudit

const normalise = (email) => String(email ?? '').toLowerCase().trim();

/** A found document as `findOne` returns it: awaitable *and* chainable onto `.select()`. */
const queryResult = (doc) => Object.assign(Promise.resolve(doc), { select: () => Promise.resolve(doc) });

const activeDepartment = () => ({ _id: DEPARTMENT_ID, name: 'Cardiology', isActive: true });

const duplicateKeyError = () => {
  const err = new Error('E11000 duplicate key error collection: users index: email_1');
  err.code = 11000;
  err.name = 'MongoServerError';
  return err;
};

/** The model methods the auth path calls, replaced with in-memory equivalents. */
const defaultStubs = () => ({
  'User.findOne': (filter = {}) => queryResult(accounts.get(normalise(filter.email)) || null),

  'User.create': async (payload) => {
    createdUsers.push(payload);
    const email = normalise(payload.email);
    // Mirrors the unique index on User.email, duplicate-key shape included.
    if (accounts.has(email)) throw duplicateKeyError();
    const doc = new User({ ...payload, email });
    doc._id = payload._id || new mongoose.Types.ObjectId(USER_ID);
    doc.password = await bcrypt.hash(payload.password, BCRYPT_COST); // what the pre-save hook stores
    accounts.set(email, doc);
    return doc;
  },

  'User.deleteOne': async (filter) => {
    deletedUsers.push(filter);
    const email = [...accounts.keys()].find((key) => String(accounts.get(key)._id) === String(filter._id));
    if (!email) return { deletedCount: 0 };
    accounts.delete(email);
    return { deletedCount: 1 };
  },

  'Doctor.create': async (payload) => {
    createdDoctors.push(payload);
    const doc = new Doctor(payload);
    doc.populate = async () => doc; // the response only needs the document, not a round trip
    return doc;
  },

  'Department.findById': async () => activeDepartment(),

  'RefreshToken.create': async (doc) => {
    sessions.push(doc);
    return doc;
  },

  'AuditLog.create': async (doc) => {
    audits.push(doc);
    return doc;
  },
});

/**
 * Install model stubs and return a restore function.
 * Restoring puts back whatever was in place before this call, so an override can never outlive
 * the test that asked for it.
 */
const installStubs = (stubs) => {
  const restore = [];
  for (const [key, value] of Object.entries(stubs)) {
    const [modelName, method] = key.split('.');
    const model = MODELS[modelName];
    assert.ok(model, `unknown model in stub key ${key}`);
    restore.push([model, method, model[method]]);
    model[method] = value;
  }
  return () => {
    for (const [model, method, original] of restore) model[method] = original;
  };
};

/**
 * Extra stubs for the duration of one test.
 * The defaults were installed in `test.before`, so restoring the captured originals puts the
 * next test back on the default set - an override cannot leak out of its own test.
 */
const stubDatabase = (t, overrides = {}) => {
  const restore = installStubs(overrides);
  t.after(() => restore());
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let ipCounter = 0;
let restoreDefaults;

/** A distinct client IP per request, so one test cannot exhaust another's rate-limit bucket. */
const nextIp = () => {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

/**
 * POST a JSON request. `contentType: null` sends the request with no content type at all (and
 * no body when `body` is undefined), which is how a badly formed client reaches the API.
 */
const post = (path, body, { ip = nextIp(), headers = {}, contentType = 'application/json' } = {}) => {
  const init = { method: 'POST', headers: { 'X-Forwarded-For': ip, ...headers } };
  if (contentType) init.headers['Content-Type'] = contentType;
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, init);
};

const register = (payload, options) => post('/api/auth/register', payload, options);
const login = (payload, options) => post('/api/auth/login', payload, options);

/** Set-Cookie lines of a response, whatever the fetch implementation exposes. */
const setCookies = (res) =>
  typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : String(res.headers.get('set-cookie') || '')
        .split(/,(?=[^;]+=)/)
        .filter(Boolean);

const cookieNamed = (res, name) => setCookies(res).find((line) => line.startsWith(`${name}=`));
const cookieValue = (res, name) => cookieNamed(res, name)?.split('=')[1].split(';')[0];

/** Assert that a response leaks neither the password, its hash, nor the raw refresh token. */
const assertNoSecretLeak = (raw, body) => {
  assert.equal(raw.includes(PASSWORD), false, 'the submitted password must never be echoed');
  assert.equal(/\$2[aby]\$/.test(raw), false, 'no bcrypt hash may be returned');
  assert.equal('password' in (body.data?.user || {}), false, 'the user payload must not carry a password');
  assert.equal(body.data?.refreshToken, undefined, 'the refresh token stays in the cookie');
};

const patientPayload = (overrides = {}) => ({
  name: 'Rosa Patient',
  email: 'rosa.patient@example.com',
  password: PASSWORD,
  role: 'patient',
  ...overrides,
});

const doctorPayload = (overrides = {}) => ({
  name: 'Dana Doctor',
  email: 'dana.doctor@example.com',
  password: PASSWORD,
  role: 'doctor',
  departmentId: DEPARTMENT_ID,
  specialization: 'Cardiology',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.before(async () => {
  // The API runs behind a proxy in production (TRUST_PROXY), which is what makes the real
  // client IP - and therefore a per-client rate-limit bucket - observable to the tests.
  app.set('trust proxy', 1);
  restoreDefaults = installStubs(defaultStubs());

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (restoreDefaults) restoreDefaults();
  if (server) server.close();
});

test.beforeEach(() => {
  // Fresh in-memory collections: no test can depend on another test's records.
  accounts = new Map();
  createdUsers = [];
  createdDoctors = [];
  deletedUsers = [];
  sessions = [];
  audits = [];
});

// ---------------------------------------------------------------------------
// Patient registration
// ---------------------------------------------------------------------------

test('a valid patient registration returns 201, a session and no sensitive fields', async () => {
  const res = await register(patientPayload());
  const raw = await res.text();
  const body = JSON.parse(raw);

  assert.equal(res.status, 201);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.ok(res.headers.get('x-request-id'), 'responses carry a correlation id');
  assert.equal(body.success, true);
  assert.equal(body.message, 'Registration successful');
  assert.equal(body.data.user.name, 'Rosa Patient');
  assert.equal(body.data.user.email, 'rosa.patient@example.com');
  assert.equal(body.data.user.role, 'patient');
  assert.equal(body.data.user.isActive, true);
  assert.equal(body.data.doctor, null);

  // The account exists exactly once, and the password is stored hashed.
  assert.equal(accounts.size, 1);
  assert.equal(createdUsers.length, 1);
  const stored = accounts.get('rosa.patient@example.com');
  assert.notEqual(stored.password, PASSWORD);
  assert.match(stored.password, /^\$2[aby]\$/);

  assertNoSecretLeak(raw, body);

  // Registration signs the user in: real cookies, a real JWT bound to the stored session.
  const refresh = cookieNamed(res, tokenUtils.REFRESH_COOKIE_NAME);
  const csrf = cookieNamed(res, tokenUtils.CSRF_COOKIE_NAME);
  assert.ok(refresh, 'the refresh cookie must be set');
  assert.match(refresh, /HttpOnly/i);
  assert.match(refresh, /Path=\/api\/auth/i);
  assert.ok(csrf, 'the csrf cookie must be set');
  assert.equal(/HttpOnly/i.test(csrf), false, 'the csrf cookie must stay readable by the frontend');

  assert.equal(sessions.length, 1);
  assert.match(sessions[0].sessionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(sessions[0].sessionId, sessions[0].familyId);
  const rawRefresh = cookieValue(res, tokenUtils.REFRESH_COOKIE_NAME);
  assert.equal(sessions[0].tokenHash, tokenUtils.hashRefreshToken(rawRefresh));
  assert.equal(JSON.stringify(sessions[0]).includes(rawRefresh), false, 'only the hash is stored');

  const decoded = jwt.verify(body.data.token, process.env.JWT_SECRET);
  assert.equal(String(decoded.id), String(stored._id));
  assert.equal(decoded.sid, sessions[0].sessionId);

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'auth.register.success');
  assert.equal(audits[0].outcome, 'success');
  assert.equal(audits[0].actorRole, 'patient');
});

test('the email is normalised before it is stored or compared', async () => {
  const res = await register(patientPayload({ email: '  Rosa.Patient@Example.COM  ' }));
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.data.user.email, 'rosa.patient@example.com');
  assert.deepEqual([...accounts.keys()], ['rosa.patient@example.com']);

  // The same address in different casing is the same account.
  const again = await register(patientPayload({ email: 'ROSA.PATIENT@example.com', name: 'Someone Else' }));
  assert.equal(again.status, 409);
  assert.equal(accounts.size, 1);
});

test('registration rejects missing and invalid fields with 400 and creates nothing', async () => {
  const cases = [
    [{ name: '' }, 'Name is required'],
    [{ name: '   ' }, 'Name is required'],
    [{ email: 'not-an-email' }, 'A valid email is required'],
    [{ email: '' }, 'A valid email is required'],
    [{ password: 'short' }, 'Password must be at least 6 characters'],
    [{ password: undefined }, 'Password must be at least 6 characters'],
    [{ role: 'nurse' }, 'Role must be patient or doctor'],
  ];

  for (const [overrides, message] of cases) {
    const res = await register(patientPayload(overrides));
    const body = await res.json();
    assert.equal(res.status, 400, `${JSON.stringify(overrides)} must be rejected`);
    assert.equal(body.success, false);
    assert.equal(body.message, message);
    assert.equal(setCookies(res).length, 0, 'a rejected registration must not start a session');
  }

  assert.equal(accounts.size, 0);
  assert.equal(createdUsers.length, 0);
  assert.equal(sessions.length, 0);
  assert.equal(audits.filter((a) => a.action === 'auth.register.success').length, 0);
});

test('self-service admin creation is refused with 403', async () => {
  const res = await register(patientPayload({ role: 'admin', name: 'Sneaky Admin' }));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.success, false);
  assert.match(body.message, /admin accounts cannot be created/i);
  assert.equal(accounts.size, 0);
});

test('a malformed JSON body is answered with 400 instead of a server error', async () => {
  const res = await post('/api/auth/register', '{ "name": "Broken", ');
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.message, 'Invalid JSON body');
  assert.equal(accounts.size, 0);
});

test('a request with no JSON body is a 400, not a server error', async () => {
  // No content type and no body: nothing parsed the request, so `req.body` is undefined.
  const registerNoBody = await post('/api/auth/register', undefined, { contentType: null });
  const registerRaw = await registerNoBody.text();
  assert.equal(registerNoBody.status, 400);
  assert.equal(JSON.parse(registerRaw).message, 'Name is required');
  assert.equal(/cannot destructure|typeerror|at object|node_modules/i.test(registerRaw), false, 'no internal error text may leak');

  const loginNoBody = await post('/api/auth/login', undefined, { contentType: null });
  const loginRaw = await loginNoBody.text();
  assert.equal(loginNoBody.status, 400);
  assert.equal(JSON.parse(loginRaw).message, 'Email and password are required');
  assert.equal(/cannot destructure|typeerror|at object|node_modules/i.test(loginRaw), false, 'no internal error text may leak');

  // An empty (or non-object) JSON body takes the same validation path.
  const emptyJson = await post('/api/auth/register', undefined, { contentType: 'application/json' });
  assert.equal(emptyJson.status, 400);
  assert.equal((await emptyJson.json()).message, 'Name is required');

  const nullJson = await post('/api/auth/register', 'null');
  assert.equal(nullJson.status, 400);
  assert.equal((await nullJson.json()).message, 'Invalid JSON body');

  assert.equal(accounts.size, 0);
  assert.equal(createdUsers.length, 0);
});

// ---------------------------------------------------------------------------
// Doctor registration
// ---------------------------------------------------------------------------

test('a valid doctor registration creates both the user and the doctor profile', async () => {
  const res = await register(doctorPayload({ qualification: 'MBBS, MD', experience: 8, consultationFee: 500 }));
  const raw = await res.text();
  const body = JSON.parse(raw);

  assert.equal(res.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.user.role, 'doctor');
  assert.equal(body.data.user.email, 'dana.doctor@example.com');
  assert.equal(body.data.doctor.specialization, 'Cardiology');
  assert.equal(body.data.doctor.experience, 8);
  assert.equal(body.data.doctor.qualification, 'MBBS, MD');
  assert.equal(String(body.data.doctor.user), String(body.data.user._id));

  assert.equal(createdUsers.length, 1);
  assert.equal(createdUsers[0].role, 'doctor');
  assert.equal(createdDoctors.length, 1);
  assert.equal(String(createdDoctors[0].user), String(body.data.user._id));
  assert.equal(String(createdDoctors[0].department), DEPARTMENT_ID);

  assertNoSecretLeak(raw, body);
  assert.ok(cookieNamed(res, tokenUtils.REFRESH_COOKIE_NAME));
  assert.equal(audits[0].action, 'auth.register.success');
  assert.equal(audits[0].actorRole, 'doctor');
});

test('doctor registration validates its own required fields', async () => {
  const cases = [
    [{ departmentId: undefined }, 'A valid departmentId is required'],
    [{ departmentId: 'not-an-id' }, 'A valid departmentId is required'],
    [{ specialization: '' }, 'Specialization is required'],
    [{ specialization: undefined }, 'Specialization is required'],
  ];

  for (const [overrides, message] of cases) {
    const res = await register(doctorPayload(overrides));
    const body = await res.json();
    assert.equal(res.status, 400, `${JSON.stringify(overrides)} must be rejected`);
    assert.equal(body.message, message);
  }

  // The shared profile validator is reused for registration, not bypassed.
  const badExperience = await register(doctorPayload({ experience: 90 }));
  assert.equal(badExperience.status, 400);
  assert.equal((await badExperience.json()).message, 'Experience must be between 0 and 70 years');

  assert.equal(accounts.size, 0);
  assert.equal(createdUsers.length, 0);
  assert.equal(createdDoctors.length, 0);
});

test('an unknown or inactive department is a 404 and no account is created', async (t) => {
  stubDatabase(t, { 'Department.findById': async () => null });

  const res = await register(doctorPayload());
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.message, 'Department not found or inactive');
  assert.equal(accounts.size, 0);
  assert.equal(createdDoctors.length, 0);
});

test('an inactive department is a 404 too', async (t) => {
  stubDatabase(t, { 'Department.findById': async () => ({ ...activeDepartment(), isActive: false }) });

  const res = await register(doctorPayload());
  assert.equal(res.status, 404);
  assert.equal((await res.json()).message, 'Department not found or inactive');
  assert.equal(accounts.size, 0);
  assert.equal(createdDoctors.length, 0);
});

test('a failed doctor profile write rolls the new user back instead of leaving an orphan', async (t) => {
  const logged = [];
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = (...args) => logged.push(args);

  stubDatabase(t, {
    'Doctor.create': async () => {
      throw new Error('Doctor validation failed: department: Path `department` is required.');
    },
  });

  const res = await register(doctorPayload());
  assert.equal(res.status, 500);
  assert.equal((await res.json()).success, false);

  // A user created for a doctor profile that failed must not survive as a profile-less account.
  assert.equal(deletedUsers.length, 1);
  assert.equal(accounts.size, 0);
  assert.equal(sessions.length, 0);
  assert.equal(audits.filter((a) => a.action === 'auth.register.success').length, 0);
  assert.ok(logged.length >= 1, 'the failure is still logged for the operator');
});

// ---------------------------------------------------------------------------
// Duplicate email
// ---------------------------------------------------------------------------

test('registering an existing email returns 409 and does not create a second account', async () => {
  const first = await register(patientPayload());
  assert.equal(first.status, 201);
  assert.equal(accounts.size, 1);

  const duplicate = await register(patientPayload({ name: 'Same Address' }));
  const body = await duplicate.json();

  assert.equal(duplicate.status, 409);
  assert.equal(body.success, false);
  assert.equal(body.message, 'Email is already registered');
  assert.equal(body.data, undefined);
  assert.equal(setCookies(duplicate).length, 0, 'a duplicate must not sign anyone in');

  assert.equal(accounts.size, 1, 'no second account may be created');
  assert.equal(createdUsers.filter((u) => normalise(u.email) === 'rosa.patient@example.com').length, 1);
  assert.equal(audits.filter((a) => a.action === 'auth.register.success').length, 1);
});

test('the duplicate check also covers doctor registration on an existing patient email', async () => {
  assert.equal((await register(patientPayload({ email: 'shared@example.com' }))).status, 201);

  const asDoctor = await register(doctorPayload({ email: 'shared@example.com' }));
  const body = await asDoctor.json();

  assert.equal(asDoctor.status, 409);
  assert.equal(body.message, 'Email is already registered');
  assert.equal(accounts.size, 1);
  assert.equal(createdDoctors.length, 0);
});

test('a duplicate refused by the database constraint is still answered with 409', async (t) => {
  // The race the controller's pre-check cannot win: the read finds nothing, the write is then
  // refused by the unique index on User.email.
  stubDatabase(t, {
    'User.findOne': () => queryResult(null),
    'User.create': async (payload) => {
      createdUsers.push(payload);
      throw duplicateKeyError();
    },
  });

  const res = await register(patientPayload());
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.success, false);
  assert.equal(body.message, 'Duplicate record: this resource already exists');
  assert.equal(accounts.size, 0, 'the refused insert must not leave an account behind');
  assert.equal(sessions.length, 0);
  assert.equal(setCookies(res).length, 0);
});

test('one account per email is enforced by the schema, not only by the controller', () => {
  assert.equal(User.schema.path('email').options.unique, true);
  assert.equal(User.schema.path('email').options.lowercase, true);
  assert.equal(User.schema.path('email').options.trim, true);
  assert.equal(Doctor.schema.path('user').options.unique, true, 'a doctor profile is unique per user');

  const emailIndex = User.schema.indexes().find(([fields]) => fields.email === 1);
  assert.ok(emailIndex, 'the unique email index must be declared on the schema');
  assert.equal(emailIndex[1].unique, true);
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('login with valid credentials returns 200, a fresh session and no secrets', async () => {
  assert.equal((await register(patientPayload())).status, 201);

  const res = await login({ email: 'rosa.patient@example.com', password: PASSWORD });
  const raw = await res.text();
  const body = JSON.parse(raw);

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.message, 'Login successful');
  assert.equal(body.data.user.email, 'rosa.patient@example.com');
  assert.equal(body.data.doctor, null);

  assertNoSecretLeak(raw, body);
  assert.ok(cookieNamed(res, tokenUtils.REFRESH_COOKIE_NAME));

  // Register and login are two separate sessions for the same account.
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
  assert.equal(sessions[1].tokenHash, tokenUtils.hashRefreshToken(cookieValue(res, tokenUtils.REFRESH_COOKIE_NAME)));
  assert.equal(jwt.verify(body.data.token, process.env.JWT_SECRET).sid, sessions[1].sessionId);
  assert.equal(audits.filter((a) => a.action === 'auth.login.success').length, 1);
});

test('login as a doctor also returns the doctor profile', async (t) => {
  assert.equal((await register(doctorPayload())).status, 201);

  // The controller chains `.populate()` onto the query, so the stub returns a document whose
  // populate resolves the same document instead of hitting the database.
  stubDatabase(t, {
    'Doctor.findOne': () => {
      const doc = new Doctor({ user: USER_ID, department: DEPARTMENT_ID, specialization: 'Cardiology' });
      doc.populate = () => Promise.resolve(doc);
      return doc;
    },
  });

  const res = await login({ email: 'dana.doctor@example.com', password: PASSWORD });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.data.user.role, 'doctor');
  assert.equal(body.data.doctor.specialization, 'Cardiology');
});

test('an unknown email and a wrong password answer identically with 401', async () => {
  assert.equal((await register(patientPayload())).status, 201);
  const sessionsBefore = sessions.length;

  const unknown = await login({ email: 'nobody@example.com', password: PASSWORD });
  const unknownRaw = await unknown.text();
  const unknownBody = JSON.parse(unknownRaw);

  const wrong = await login({ email: 'rosa.patient@example.com', password: 'WrongPassword1' });
  const wrongRaw = await wrong.text();
  const wrongBody = JSON.parse(wrongRaw);

  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknownBody.success, false);
  assert.equal(wrongBody.success, false);
  assert.equal(unknownBody.message, 'Invalid email or password');
  assert.equal(wrongBody.message, unknownBody.message, 'both failures must look the same');
  assert.equal(unknownBody.data, undefined);
  assert.equal(wrongBody.data, undefined);

  for (const raw of [unknownRaw, wrongRaw]) {
    assert.equal(raw.includes(PASSWORD), false);
    assert.equal(raw.includes('WrongPassword1'), false);
    assert.equal(/\$2[aby]\$/.test(raw), false);
  }

  assert.equal(sessions.length, sessionsBefore, 'a failed login must not create a session');
  assert.equal(setCookies(unknown).length, 0);
  assert.equal(setCookies(wrong).length, 0);
  assert.deepEqual(
    audits.map((a) => a.action),
    ['auth.register.success', 'auth.login.failed', 'auth.login.failed']
  );
  // The attempted address is deliberately not written to the audit trail.
  assert.equal(JSON.stringify(audits).includes('nobody@example.com'), false);
});

test('login without usable credentials is a 400', async () => {
  const cases = [
    [{}, 'Email and password are required'],
    [{ email: 'rosa.patient@example.com' }, 'Email and password are required'],
    [{ email: 'rosa.patient@example.com', password: '' }, 'Email and password are required'],
    [{ email: 'not-an-email', password: PASSWORD }, 'Email and password are required'],
  ];

  for (const [payload, message] of cases) {
    const res = await login(payload);
    const body = await res.json();
    assert.equal(res.status, 400, `${JSON.stringify(payload)} must be a validation error`);
    assert.equal(body.message, message);
  }
  assert.equal(sessions.length, 0);
});

test('login is rejected for a password of the wrong type', async () => {
  assert.equal((await register(patientPayload())).status, 201);

  for (const password of [123456, { $ne: null }, ['secret123'], true, null]) {
    const res = await login({ email: 'rosa.patient@example.com', password });
    const body = await res.json();
    assert.equal(res.status, 400, `${JSON.stringify(password)} must not be accepted`);
    assert.equal(body.message, 'Email and password are required');
  }
  assert.equal(sessions.length, 1, 'only the registration session exists');
});

test('a deactivated account cannot log in even with the right password', async () => {
  assert.equal((await register(patientPayload())).status, 201);
  accounts.get('rosa.patient@example.com').isActive = false;

  const res = await login({ email: 'rosa.patient@example.com', password: PASSWORD });
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.message, 'Account is deactivated');
  assert.equal(sessions.length, 1, 'only the session created at registration exists');

  accounts.get('rosa.patient@example.com').isActive = true;
  const ok = await login({ email: 'rosa.patient@example.com', password: PASSWORD });
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------------------
// Harness reliability
// ---------------------------------------------------------------------------

test('repeated attempts from one client are still rate limited', async () => {
  // The limiter is mounted in server.js, so this is the only level at which it can be observed.
  const ip = '10.9.9.9';
  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await login({ email: 'nobody@example.com', password: PASSWORD }, { ip });
    statuses.push(res.status);
    if (attempt === 5) {
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.message, /too many authentication attempts/i);
    }
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429);
});

test('the suite never opened a database connection', () => {
  // Every model call is stubbed: if this ever fails, the tests were talking to a real MongoDB.
  assert.equal(mongoose.connection.readyState, 0, 'mongoose must still be disconnected');
});

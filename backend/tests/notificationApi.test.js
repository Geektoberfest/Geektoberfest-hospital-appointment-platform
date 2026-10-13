process.env.JWT_SECRET = 'test_secret_for_notification_api_tests_1234567890';
process.env.NODE_ENV = 'test';
process.env.CLIENT_URL = 'http://localhost:5173';
// Keep the heartbeat visible inside a test run instead of waiting 25 seconds for it.
process.env.SSE_HEARTBEAT_MS = '40';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Availability = require('../models/Availability');
const Doctor = require('../models/Doctor');
const RefreshToken = require('../models/RefreshToken');
const WaitingList = require('../models/WaitingList');
const AuditLog = require('../models/AuditLog');
const generateToken = require('../utils/generateToken');
const notifications = require('../services/notificationService');
const { TICKET_VALUE_RE } = require('../utils/sseTickets');

const PATIENT_ID = '507f1f77bcf86cd799439011';
const OTHER_PATIENT_ID = '507f1f77bcf86cd799439022';
const SESSION_ID = '3f6c1f8e-0d2b-4a9c-9f7a-1b2c3d4e5f60';

const audits = [];
const originals = {
  userFindById: User.findById,
  sessionExists: RefreshToken.exists,
  auditCreate: AuditLog.create,
  appointmentFindById: Appointment.findById,
  appointmentExists: Appointment.exists,
  appointmentCreate: Appointment.create,
  availabilityFindSlot: Availability.findSlot,
  doctorFindById: Doctor.findById,
  waitingListFind: WaitingList.find,
};

/** Replace model methods for the duration of one test. */
const stubModels = (t, stubs) => {
  const models = { Appointment, Availability, Doctor, WaitingList };
  const restore = new Map();
  for (const [key, value] of Object.entries(stubs)) {
    const [modelName, method] = key.split('.');
    const model = models[modelName];
    assert.ok(model, `unknown model in stub key ${key}`);
    restore.set(key, [model, method, model[method]]);
    model[method] = value;
  }
  t.after(() => {
    for (const [, [model, method, original]] of restore) model[method] = original;
  });
};


let server;
let baseUrl;
let currentUser = { _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' };
let sessionActive = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tokenFor = (id = PATIENT_ID, role = 'patient') => generateToken(id, SESSION_ID);

test.before(async () => {
  AuditLog.create = async (doc) => {
    audits.push(doc);
    return doc;
  };
  User.findById = async () => currentUser;
  RefreshToken.exists = async () => (sessionActive ? { _id: '1' } : null);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  notifications.closeAll();
  User.findById = originals.userFindById;
  RefreshToken.exists = originals.sessionExists;
  AuditLog.create = originals.auditCreate;
  Appointment.findById = originals.appointmentFindById;
  Appointment.exists = originals.appointmentExists;
  Appointment.create = originals.appointmentCreate;
  Availability.findSlot = originals.availabilityFindSlot;
  Doctor.findById = originals.doctorFindById;
  WaitingList.find = originals.waitingListFind;
  server?.closeAllConnections?.();
  if (server) server.close();
});

/** Attach a catch so an aborted read can never surface as an unhandled rejection. */
const readOnce = (reader) => {
  const pending = reader.read();
  pending.catch(() => {});
  return pending;
};

const TIMEOUT = Symbol('timeout');

/**
 * Buffered reader for one response. It keeps a single outstanding `read()` between
 * calls, so a "wait 250 ms and expect nothing" check cannot swallow the frame that
 * arrives immediately afterwards.
 */
const streamReader = (res) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = readOnce(reader);
  let text = '';

  const readMore = async (until = () => false, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const race = await Promise.race([pending, sleep(Math.max(1, deadline - Date.now())).then(() => TIMEOUT)]);
      if (race === TIMEOUT) break;
      pending = readOnce(reader);
      if (race.done) break;
      text += decoder.decode(race.value, { stream: true });
      if (until(text)) break;
    }
    return text;
  };

  return { readMore, text: () => text };
};

const requestTicket = (token = tokenFor()) =>
  fetch(`${baseUrl}/api/notifications/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

const issuedTicket = async (token = tokenFor()) => {
  const res = await requestTicket(token);
  assert.equal(res.status, 201);
  const body = await res.json();
  return body.data.ticket;
};

const streamUrl = (ticket) => `${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`;

const openStream = (ticket, options) => fetch(streamUrl(ticket), options);

// ---------------------------------------------------------------------------
// Ticket issuance
// ---------------------------------------------------------------------------

test('anonymous callers cannot request a notification ticket', async () => {
  const res = await fetch(`${baseUrl}/api/notifications/ticket`, { method: 'POST' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /token missing/i);
  assert.equal(body.data, undefined);
  assert.ok(res.headers.get('x-request-id'));
});

test('only patients can request a notification ticket', async () => {
  const before = audits.length;
  const asPatient = currentUser;

  try {
    // The role comes from the authoritative user record, never from the token payload.
    currentUser = { _id: PATIENT_ID, role: 'doctor', isActive: true, name: 'Test Doctor' };
    const doctor = await requestTicket(tokenFor(PATIENT_ID, 'doctor'));
    assert.equal(doctor.status, 403);
    assert.match((await doctor.json()).message, /not allowed/i);

    currentUser = { _id: PATIENT_ID, role: 'admin', isActive: true, name: 'Test Admin' };
    const admin = await requestTicket(tokenFor(PATIENT_ID, 'admin'));
    assert.equal(admin.status, 403);
  } finally {
    currentUser = asPatient;
  }

  await sleep(20); // audit writes are fire-and-forget
  const denial = audits.slice(before).find((a) => a.action === 'rbac.access.denied');
  assert.ok(denial, 'the refusal must be audited');
  assert.equal(denial.outcome, 'denied');
});

test('a patient receives one short-lived ticket and nothing else', async () => {
  const res = await requestTicket();
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.message, 'Notification ticket issued');
  assert.match(body.data.ticket, TICKET_VALUE_RE);
  assert.equal(body.data.expiresIn, 30000);
  // The ticket is not a general credential: no identity, session or token material.
  assert.equal(body.data.userId, undefined);
  assert.equal(body.data.sessionId, undefined);
  assert.equal(body.data.token, undefined);
  assert.equal(JSON.stringify(body).includes(tokenFor()), false);

  // Two tickets never collide.
  const other = await fetch(`${baseUrl}/api/notifications/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor()}`, 'Content-Type': 'application/json' },
  });
  assert.notEqual((await other.json()).data.ticket, body.data.ticket);
});

// ---------------------------------------------------------------------------
// Stream authentication
// ---------------------------------------------------------------------------

test('the stream rejects missing, malformed, repeated and unpresented tickets', async () => {
  const cases = [
    `${baseUrl}/api/notifications/stream`,
    `${baseUrl}/api/notifications/stream?ticket=`,
    `${baseUrl}/api/notifications/stream?ticket=short`,
    `${baseUrl}/api/notifications/stream?ticket=${'a'.repeat(200)}`,
    `${baseUrl}/api/notifications/stream?ticket=not-a-ticket-value`,
    `${baseUrl}/api/notifications/stream?ticket=AAAA&ticket=BBBB`,
  ];

  for (const url of cases) {
    const res = await fetch(url);
    assert.equal(res.status, 401, `expected 401 for ${url}`);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /ticket/i);
    assert.equal(body.stack, undefined);
  }
});

test('the stream refuses to open when the session has been revoked', async () => {
  const ticket = await issuedTicket();
  sessionActive = false;
  try {
    const res = await openStream(ticket);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.message, /revoked or expired/i);
  } finally {
    sessionActive = true;
  }
});

// ---------------------------------------------------------------------------
// Stream transport
// ---------------------------------------------------------------------------

test('a valid ticket opens a stream with the required headers, a retry hint and heartbeats', async () => {
  const ticket = await issuedTicket();
  const controller = new AbortController();

  try {
    const res = await openStream(ticket, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(res.headers.get('cache-control') || '', /no-cache/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');

    const reader = streamReader(res);
    const first = await reader.readMore((t) => t.includes(': connected'), 1500);
    assert.match(first, /retry: 30000/);
    assert.match(first, /: connected/);

    // Heartbeats are comments, never events.
    const beats = await reader.readMore((t) => t.includes(': ping'), 1500);
    assert.match(beats, /: ping/);
    assert.equal(beats.includes('event:'), false, 'the stream stays silent until something is assigned');
  } finally {
    controller.abort();
    await sleep(50);
  }

  assert.equal(notifications.userConnectionCount(PATIENT_ID), 0, 'the connection is released on disconnect');
});

test('a ticket is single use over HTTP', async () => {
  const ticket = await issuedTicket();

  const controller = new AbortController();
  const res = await openStream(ticket, { signal: controller.signal });
  assert.equal(res.status, 200);
  controller.abort();
  await sleep(50);

  const reuse = await openStream(ticket);
  assert.equal(reuse.status, 401);
  assert.match((await reuse.json()).message, /already used/i);
});

test('concurrent stream requests with the same ticket have exactly one winner', async () => {
  const ticket = await issuedTicket();
  const controllers = [new AbortController(), new AbortController()];

  try {
    const results = await Promise.all([
      openStream(ticket, { signal: controllers[0].signal }),
      openStream(ticket, { signal: controllers[1].signal }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 401]);
  } finally {
    controllers.forEach((c) => c.abort());
    await sleep(50);
  }
});

test('a ticket only subscribes its own patient', async () => {
  // Two tickets, one per patient, using the same stubbed sign-in flow.
  const patientTicket = await issuedTicket();
  currentUser = { _id: OTHER_PATIENT_ID, role: 'patient', isActive: true, name: 'Other Patient' };
  const otherTicket = await issuedTicket(tokenFor(OTHER_PATIENT_ID));
  currentUser = { _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' };

  const controller = new AbortController();
  const otherController = new AbortController();
  try {
    const res = await openStream(patientTicket, { signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = streamReader(res);

    // Give the stream a moment to register before addressing the patients.
    await reader.readMore((t) => t.includes(': connected'), 1500);
    assert.equal(notifications.userConnectionCount(PATIENT_ID), 1);

    // Another patient's event must not reach this stream.
    assert.equal(notifications.notifyUser(OTHER_PATIENT_ID, 'waitlist.assigned', { appointmentId: 'other' }), 0);
    const quiet = await reader.readMore((t) => t.includes('waitlist.assigned'), 250);
    assert.equal(quiet.includes('waitlist.assigned'), false);

    // The owner of the ticket does receive it.
    assert.equal(notifications.notifyUser(PATIENT_ID, 'waitlist.assigned', { appointmentId: 'mine', date: '2099-06-15' }), 1);
    const delivered = await reader.readMore((t) => t.includes('waitlist.assigned'), 1500);
    assert.match(delivered, /event: waitlist\.assigned/);
    assert.match(delivered, /"appointmentId":"mine"/);

    // The other patient's own ticket still only opens their own stream.
    const stray = await openStream(otherTicket, { signal: otherController.signal });
    assert.equal(stray.status, 200, 'the other patient still gets their own stream');
    // Wait for the server to confirm the stream before counting registrations.
    await streamReader(stray).readMore((t) => t.includes(': connected'), 1500);
    assert.equal(notifications.userConnectionCount(OTHER_PATIENT_ID), 1);
  } finally {
    controller.abort();
    otherController.abort();
    await sleep(80);
  }

  assert.equal(notifications.connectionCount(), 0);
});

test('cancelling an appointment end to end notifies the waiting-list patient over the open stream', async (t) => {
  const appointmentId = '507f1f77bcf86cd799439099';
  const reassignedId = '507f1f77bcf86cd7994390aa';
  const entry = {
    _id: '507f1f77bcf86cd799439055',
    doctor: '507f1f77bcf86cd799439033',
    patient: OTHER_PATIENT_ID,
    status: 'waiting',
    notes: 'Urgent consultation needed',
    save: async () => entry,
  };
  const cancelledAppointment = {
    _id: appointmentId,
    patient: PATIENT_ID,
    doctor: entry.doctor,
    date: '2099-06-15',
    startTime: '10:00',
    endTime: '10:30',
    status: 'booked',
    cancelledBy: '',
    save: async () => cancelledAppointment,
    populate: async () => cancelledAppointment,
  };

  stubModels(t, {
    'Appointment.findById': async () => cancelledAppointment,
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [entry] }),
    'Doctor.findById': async () => ({ _id: entry.doctor, department: null, isActive: true }),
    'Appointment.exists': async () => false,
    'Appointment.create': async (data) => ({
      _id: reassignedId,
      ...data,
      status: 'booked',
      populate: async () => ({}),
    }),
  });

  // The patient on the waiting list opens their notification stream first.
  currentUser = { _id: OTHER_PATIENT_ID, role: 'patient', isActive: true, name: 'Waiting Patient' };
  const ticket = await issuedTicket(tokenFor(OTHER_PATIENT_ID));
  currentUser = { _id: PATIENT_ID, role: 'patient', isActive: true, name: 'Test Patient' };

  const controller = new AbortController();
  try {
    const stream = await openStream(ticket, { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = streamReader(stream);
    await reader.readMore((t) => t.includes(': connected'), 1500);

    // The holder of the slot cancels it through the real endpoint.
    const res = await fetch(`${baseUrl}/api/appointments/${appointmentId}/cancel`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenFor(PATIENT_ID)}`, 'Content-Type': 'application/json' },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'Appointment cancelled');
    assert.equal(body.reassignedAppointmentId, reassignedId, 'the freed slot went to the waiting list');
    assert.equal(cancelledAppointment.status, 'cancelled');
    assert.equal(entry.status, 'assigned');

    const delivered = await reader.readMore((t) => t.includes('waitlist.assigned'), 2000);
    assert.match(delivered, /event: waitlist\.assigned/);
    assert.match(delivered, new RegExp(`"appointmentId":"${reassignedId}"`));
    assert.match(delivered, /"waitingListEntryId":"507f1f77bcf86cd799439055"/);
    assert.match(delivered, /"date":"2099-06-15"/);
    assert.match(delivered, /"status":"booked"/);
    // The clinical note on the cancelled appointment is never published.
    assert.equal(delivered.includes('Urgent consultation'), false);
  } finally {
    controller.abort();
    await sleep(50);
  }
});

test('opening many streams for one patient stays bounded and all are cleaned up', async () => {
  const controllers = [];
  const tickets = [];
  for (let i = 0; i < 3; i += 1) tickets.push(await issuedTicket());

  try {
    for (const ticket of tickets) {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await openStream(ticket, { signal: controller.signal });
      assert.equal(res.status, 200);
    }
    assert.equal(notifications.userConnectionCount(PATIENT_ID), 3);
  } finally {
    controllers.forEach((c) => c.abort());
    await sleep(80);
  }

  assert.equal(notifications.userConnectionCount(PATIENT_ID), 0);
  assert.equal(notifications.connectionCount(), 0);
});

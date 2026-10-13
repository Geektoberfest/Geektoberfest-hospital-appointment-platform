process.env.JWT_SECRET = 'test_secret_for_waitlist_notification_tests';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const Appointment = require('../models/Appointment');
const Availability = require('../models/Availability');
const Doctor = require('../models/Doctor');
const WaitingList = require('../models/WaitingList');
const notifications = require('../services/notificationService');
const waitingListController = require('../controllers/waitingListController');

const { assignFromWaitingList, WAITLIST_ASSIGNED_EVENT } = waitingListController;

const PATIENT_ID = '507f1f77bcf86cd799439011';
const OTHER_PATIENT_ID = '507f1f77bcf86cd799439022';
const DOCTOR_ID = '507f1f77bcf86cd799439033';
const DEPARTMENT_ID = '507f1f77bcf86cd799439044';
const ENTRY_ID = '507f1f77bcf86cd799439055';
const APPOINTMENT_ID = '507f1f77bcf86cd799439066';

const MODELS = { Appointment, Availability, Doctor, WaitingList };

/** Replace model methods for the duration of one test. */
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

/** Capture notification delivery instead of writing to a socket. */
const captureNotifications = (t, { impl } = {}) => {
  const delivered = [];
  const original = notifications.notifyUser;
  notifications.notifyUser = impl || ((userId, event, data) => {
    delivered.push({ userId: String(userId), event, data });
    return 1;
  });
  t.after(() => {
    notifications.notifyUser = original;
  });
  return delivered;
};

const silentErrors = (t) => {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
};

/** A freed slot in the future, cancelled by another patient. */
const cancelledAppointment = () => ({
  _id: '507f1f77bcf86cd799439099',
  doctor: DOCTOR_ID,
  patient: OTHER_PATIENT_ID,
  date: '2099-06-15',
  startTime: '10:00',
  endTime: '10:30',
  status: 'cancelled',
  cancelledBy: 'patient',
});

/** A waiting entry plus the recording of the writes the controller performs. */
const makeEntry = (order = []) => {
  const entry = {
    _id: ENTRY_ID,
    doctor: DOCTOR_ID,
    patient: PATIENT_ID,
    desiredDate: '2099-06-15',
    status: 'waiting',
    preferredTime: '',
    notes: 'Urgent consultation needed',
    save: async () => {
      order.push('entry.save');
      return entry;
    },
  };
  return entry;
};

const doctorDoc = (t) => ({
  _id: DOCTOR_ID,
  department: DEPARTMENT_ID,
  specialization: 'Cardiology',
  isActive: true,
  user: { name: 'Asha Rao' },
  populate: async () => doctorDoc(t),
});

test('a successful reassignment notifies exactly the assigned patient with a minimal payload', async (t) => {
  const delivered = captureNotifications(t);
  const order = [];
  const entry = makeEntry(order);
  const created = { _id: APPOINTMENT_ID, doctor: DOCTOR_ID, patient: PATIENT_ID, date: '2099-06-15', startTime: '10:00', endTime: '10:30', status: 'booked', reason: entry.notes };

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [entry] }),
    'Doctor.findById': async () => doctorDoc(t),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => {
      order.push('appointment.create');
      return created;
    },
  });

  const result = await assignFromWaitingList(cancelledAppointment());

  assert.equal(result, created, 'the reassigned appointment is still returned');
  assert.equal(entry.status, 'assigned');
  assert.equal(entry.appointment, APPOINTMENT_ID);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event, WAITLIST_ASSIGNED_EVENT);
  assert.equal(delivered[0].event, 'waitlist.assigned');
  assert.equal(delivered[0].userId, PATIENT_ID, 'only the newly assigned patient is notified');
  assert.deepEqual(delivered[0].data, {
    appointmentId: APPOINTMENT_ID,
    waitingListEntryId: ENTRY_ID,
    date: '2099-06-15',
    startTime: '10:00',
    endTime: '10:30',
    doctorName: 'Asha Rao',
    specialization: 'Cardiology',
    status: 'booked',
  });

  // The payload is limited to booking facts: no clinical notes, contact details or credentials.
  const serialized = JSON.stringify(delivered[0].data);
  for (const forbidden of ['Urgent consultation', 'reason', 'notes', 'email', 'password', 'token', 'sessionId']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not be published to the stream`);
  }

  // The notification happens strictly after the appointment and the entry are persisted.
  assert.deepEqual(order, ['appointment.create', 'entry.save']);
});

test('the assignment payload falls back to an empty doctor name when the lookup is unavailable', async (t) => {
  const delivered = captureNotifications(t);
  const entry = makeEntry();

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [entry] }),
    // A driver/stub without `populate` must not break the notification or the assignment.
    'Doctor.findById': async () => ({ _id: DOCTOR_ID, isActive: true }),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => ({ _id: APPOINTMENT_ID, doctor: DOCTOR_ID, patient: PATIENT_ID, date: '2099-06-15', startTime: '10:00', endTime: '10:30', status: 'booked' }),
  });

  assert.ok(await assignFromWaitingList(cancelledAppointment()));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data.doctorName, '');
  assert.equal(delivered[0].data.specialization, '');
});

test('a notification failure cannot break a persisted reassignment', async (t) => {
  silentErrors(t);
  captureNotifications(t, {
    impl: () => {
      throw new Error('notification registry unavailable');
    },
  });
  const entry = makeEntry();
  const created = { _id: APPOINTMENT_ID, doctor: DOCTOR_ID, patient: PATIENT_ID, date: '2099-06-15', startTime: '10:00', endTime: '10:30', status: 'booked' };

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [entry] }),
    'Doctor.findById': async () => doctorDoc(t),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => created,
  });

  const result = await assignFromWaitingList(cancelledAppointment());

  assert.equal(result, created, 'the appointment must survive a notification error');
  assert.equal(entry.status, 'assigned');
  assert.equal(entry.appointment, APPOINTMENT_ID);
});

test('nothing is published when there is no eligible waiting entry', async (t) => {
  const delivered = captureNotifications(t);

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [] }),
    'Doctor.findById': async () => doctorDoc(t),
  });

  assert.equal(await assignFromWaitingList(cancelledAppointment()), null);
  assert.equal(delivered.length, 0);
});

test('nothing is published when the availability window disappeared', async (t) => {
  const delivered = captureNotifications(t);
  let waited = 0;

  stubModels(t, {
    'Availability.findSlot': async () => null,
    'WaitingList.find': () => {
      waited += 1;
      return { sort: () => [] };
    },
  });

  assert.equal(await assignFromWaitingList(cancelledAppointment()), null);
  assert.equal(waited, 0, 'the waiting list is not even queried');
  assert.equal(delivered.length, 0);
});

test('nothing is published when the appointment slot was already taken (duplicate key)', async (t) => {
  const delivered = captureNotifications(t);
  const entry = makeEntry();

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [entry] }),
    'Doctor.findById': async () => doctorDoc(t),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => {
      const err = new Error('E11000 duplicate key error collection: appointments index: unique_active_doctor_slot');
      err.code = 11000;
      throw err;
    },
  });

  assert.equal(await assignFromWaitingList(cancelledAppointment()), null);
  assert.equal(entry.status, 'waiting', 'the entry stays waiting for the next freed slot');
  assert.equal(delivered.length, 0, 'a failed reassignment must never be announced');
});

test('a failed reassignment is not announced even when a later candidate succeeds', async (t) => {
  const delivered = captureNotifications(t);
  const firstEntry = makeEntry();
  const secondEntry = { ...makeEntry(), _id: '507f1f77bcf86cd799439077', patient: '507f1f77bcf86cd799439088' };
  let attempts = 0;

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [firstEntry, secondEntry] }),
    'Doctor.findById': async () => doctorDoc(t),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      return { _id: APPOINTMENT_ID, doctor: DOCTOR_ID, patient: secondEntry.patient, date: '2099-06-15', startTime: '10:00', endTime: '10:30', status: 'booked' };
    },
  });

  const result = await assignFromWaitingList(cancelledAppointment());

  assert.ok(result);
  assert.equal(delivered.length, 1, 'only the patient who actually got the slot is notified');
  assert.equal(delivered[0].userId, '507f1f77bcf86cd799439088');
  assert.equal(firstEntry.status, 'waiting');
});

test('retrying the same cancellation does not produce a duplicate notification', async (t) => {
  const delivered = captureNotifications(t);
  const entry = makeEntry();
  const cancelled = cancelledAppointment();

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    // Mirrors the real query filter: once the entry is assigned it is no longer a candidate.
    'WaitingList.find': () => ({ sort: () => (entry.status === 'waiting' ? [entry] : []) }),
    'Doctor.findById': async () => doctorDoc(t),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => ({ _id: APPOINTMENT_ID, doctor: DOCTOR_ID, patient: PATIENT_ID, date: '2099-06-15', startTime: '10:00', endTime: '10:30', status: 'booked' }),
  });

  const first = await assignFromWaitingList(cancelled);
  const second = await assignFromWaitingList(cancelled);

  assert.ok(first);
  assert.equal(second, null, 'the slot is gone, so the retry reassigns nothing');
  assert.equal(delivered.length, 1, 'exactly one waitlist.assigned event is emitted');
});

test('an offline patient is still assigned the slot', async (t) => {
  // Real registry, no connections: notifyUser resolves to 0 deliveries.
  notifications.closeAll();
  const entry = makeEntry();

  stubModels(t, {
    'Availability.findSlot': async () => ({ slot: { startTime: '10:00', endTime: '10:30' } }),
    'WaitingList.find': () => ({ sort: () => [entry] }),
    'Doctor.findById': async () => doctorDoc(t),
    'Appointment.exists': async () => false,
    'Appointment.create': async () => ({ _id: APPOINTMENT_ID, doctor: DOCTOR_ID, patient: PATIENT_ID, date: '2099-06-15', startTime: '10:00', endTime: '10:30', status: 'booked' }),
  });

  assert.ok(await assignFromWaitingList(cancelledAppointment()));
  assert.equal(entry.status, 'assigned');
  assert.equal(notifications.notifyUser(PATIENT_ID, WAITLIST_ASSIGNED_EVENT, {}), 0);
});

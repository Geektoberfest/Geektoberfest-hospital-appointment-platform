process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Availability = require('../models/Availability');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const {
  createAvailability,
  updateAvailability,
  removeAvailability,
  getDoctorSlots,
} = require('../controllers/availabilityController');
const { errorHandler } = require('../middlewares/errorHandler');

const executeHandler = async (handler, req) => {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return res; },
    json(payload) { body = payload; return res; },
  };
  return new Promise((resolve) => {
    const next = (error) => {
      if (error) errorHandler(error, req, res, () => {});
      resolve({ status, body, error });
    };
    Promise.resolve(handler(req, res, next)).then(() => resolve({ status, body, error: null })).catch(next);
  });
};

test('updating a one-off window cannot add a break over an existing appointment', async (t) => {
  const originals = {
    findById: Availability.findById,
    find: Availability.find,
    findOne: Doctor.findOne,
    appointmentFind: Appointment.find,
  };
  t.after(() => {
    Availability.findById = originals.findById;
    Availability.find = originals.find;
    Doctor.findOne = originals.findOne;
    Appointment.find = originals.appointmentFind;
  });

  const doctorId = new mongoose.Types.ObjectId();
  const windowId = new mongoose.Types.ObjectId();
  const availability = {
    _id: windowId,
    doctor: doctorId,
    isRecurring: false,
    isActive: true,
    date: '2099-06-15',
    startTime: '09:00',
    endTime: '11:00',
    slotDuration: 30,
    breaks: [],
    startDate: '',
    endDate: '',
    daysOfWeek: [],
    getSlots() {
      return [
        { startTime: '09:00', endTime: '09:30' },
        { startTime: '09:30', endTime: '10:00' },
        { startTime: '10:00', endTime: '10:30' },
        { startTime: '10:30', endTime: '11:00' },
      ];
    },
    save: async () => {},
  };
  Availability.findById = async () => availability;
  Availability.find = async () => [];
  Doctor.findOne = async () => ({ _id: doctorId, isActive: true });
  Appointment.find = async () => [{ date: availability.date, startTime: '10:00' }];

  const req = {
    user: { _id: new mongoose.Types.ObjectId() },
    params: { id: String(windowId) },
    body: { breaks: [{ startTime: '10:00', endTime: '10:30', label: 'Lunch' }] },
  };
  const result = await executeHandler(updateAvailability, req);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /remove slots that already have booked appointments/);
});

test('deactivating a recurring window with an active appointment is rejected', async (t) => {
  const originals = {
    findById: Availability.findById,
    find: Availability.find,
    findOne: Doctor.findOne,
    appointmentFind: Appointment.find,
  };
  t.after(() => {
    Availability.findById = originals.findById;
    Availability.find = originals.find;
    Doctor.findOne = originals.findOne;
    Appointment.find = originals.appointmentFind;
  });

  const doctorId = new mongoose.Types.ObjectId();
  const windowId = new mongoose.Types.ObjectId();
  const availability = new Availability({
    _id: windowId,
    doctor: doctorId,
    isRecurring: true,
    daysOfWeek: [1],
    startTime: '09:00',
    endTime: '10:00',
    slotDuration: 30,
  });
  availability.save = async () => {};
  Availability.findById = async () => availability;
  Availability.find = async () => [];
  Doctor.findOne = async () => ({ _id: doctorId, isActive: true });
  Appointment.find = async () => [{ date: '2099-06-15', startTime: '09:00' }];

  const req = {
    user: { _id: new mongoose.Types.ObjectId() },
    params: { id: String(windowId) },
    body: { isActive: false },
  };
  const result = await executeHandler(updateAvailability, req);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /remove slots that already have booked appointments/);
});

test('removing a recurring window with an active appointment is rejected', async (t) => {
  const originals = {
    findById: Availability.findById,
    find: Availability.find,
    findOne: Doctor.findOne,
    appointmentFind: Appointment.find,
  };
  t.after(() => {
    Availability.findById = originals.findById;
    Availability.find = originals.find;
    Doctor.findOne = originals.findOne;
    Appointment.find = originals.appointmentFind;
  });

  const doctorId = new mongoose.Types.ObjectId();
  const windowId = new mongoose.Types.ObjectId();
  const availability = new Availability({
    _id: windowId,
    doctor: doctorId,
    isRecurring: true,
    daysOfWeek: [1],
    startTime: '09:00',
    endTime: '10:00',
    slotDuration: 30,
  });
  Availability.findById = async () => availability;
  Availability.find = async () => [];
  Doctor.findOne = async () => ({ _id: doctorId, isActive: true });
  Appointment.find = async () => [{ date: '2099-06-15', startTime: '09:00' }];

  const req = { user: { _id: new mongoose.Types.ObjectId() }, params: { id: String(windowId) } };
  const result = await executeHandler(removeAvailability, req);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /booked appointments/);
});

test('a one-off window cannot overlap an active recurring window', async (t) => {
  const originals = {
    find: Availability.find,
    create: Availability.create,
    findOne: Doctor.findOne,
  };
  t.after(() => {
    Availability.find = originals.find;
    Availability.create = originals.create;
    Doctor.findOne = originals.findOne;
  });

  const doctorId = new mongoose.Types.ObjectId();
  Availability.find = async () => [{
    isRecurring: true,
    daysOfWeek: [1],
    startDate: '',
    endDate: '',
    startTime: '09:00',
    endTime: '11:00',
  }];
  Availability.create = async () => assert.fail('overlapping availability must not be created');
  Doctor.findOne = async () => ({ _id: doctorId, isActive: true });

  const req = {
    user: { _id: new mongoose.Types.ObjectId() },
    body: { date: '2099-06-15', startTime: '10:00', endTime: '12:00', slotDuration: 30 },
  };
  const result = await executeHandler(createAvailability, req);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /overlaps with an existing window/);
});

test('slot listings query legacy one-off records whose isRecurring field is missing', async (t) => {
  const originals = {
    find: Availability.find,
    findById: Doctor.findById,
    appointmentFind: Appointment.find,
  };
  t.after(() => {
    Availability.find = originals.find;
    Doctor.findById = originals.findById;
    Appointment.find = originals.appointmentFind;
  });

  const doctorId = new mongoose.Types.ObjectId();
  const filters = [];
  Availability.find = (query) => {
    filters.push(query);
    return { sort: async () => [] };
  };
  Doctor.findById = async () => ({ _id: doctorId, isActive: true });
  Appointment.find = () => ({ select: async () => [] });

  const req = {
    params: { doctorId: String(doctorId) },
    query: { date: '2099-06-15' },
  };
  const result = await executeHandler(getDoctorSlots, req);
  assert.equal(result.status, 200);
  assert.deepEqual(filters[0].isRecurring, { $ne: true });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Import models
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const { cancelAppointment, submitAppointmentReview } = require('../controllers/appointmentController');

// ---------------------------------------------------------------------------
// 1. Schema Validation Tests
// ---------------------------------------------------------------------------

test('Appointment schema contains cancellationReason with correct constraints', () => {
  const cancellationReasonPath = Appointment.schema.path('cancellationReason');
  assert.ok(cancellationReasonPath, 'cancellationReason should exist on Appointment schema');
  assert.equal(cancellationReasonPath.instance, 'String');
  assert.equal(cancellationReasonPath.options.maxlength, 500);
  assert.equal(cancellationReasonPath.options.default, '');
});

test('Appointment schema contains review subdocument with rating, comment, and reviewedAt', () => {
  const ratingPath = Appointment.schema.path('review.rating');
  assert.ok(ratingPath, 'review.rating should exist on Appointment schema');
  assert.equal(ratingPath.instance, 'Number');
  assert.equal(ratingPath.options.min, 1);
  assert.equal(ratingPath.options.max, 5);

  const commentPath = Appointment.schema.path('review.comment');
  assert.ok(commentPath, 'review.comment should exist on Appointment schema');
  assert.equal(commentPath.instance, 'String');
  assert.equal(commentPath.options.maxlength, 1000);

  const reviewedAtPath = Appointment.schema.path('review.reviewedAt');
  assert.ok(reviewedAtPath, 'review.reviewedAt should exist on Appointment schema');
  assert.equal(reviewedAtPath.instance, 'Date');
});

test('Appointment schema includes index on doctor and review.rating', () => {
  const indexes = Appointment.schema.indexes();
  const reviewIndex = indexes.find(
    ([fields]) => fields.doctor === 1 && fields['review.rating'] === 1
  );
  assert.ok(reviewIndex, 'Index on { doctor: 1, "review.rating": 1 } should be defined');
});

test('Appointment.populateFields includes doctor rating aggregates', () => {
  const doctorPopulate = Appointment.populateFields.find((p) => p.path === 'doctor');
  assert.ok(doctorPopulate, 'Doctor populate config should exist');
  assert.ok(doctorPopulate.select.includes('ratingAverage'), 'Should select ratingAverage');
  assert.ok(doctorPopulate.select.includes('reviewCount'), 'Should select reviewCount');
});

test('Doctor schema contains ratingAverage and reviewCount aggregates', () => {
  const ratingAvgPath = Doctor.schema.path('ratingAverage');
  assert.ok(ratingAvgPath, 'ratingAverage should exist on Doctor schema');
  assert.equal(ratingAvgPath.instance, 'Number');
  assert.equal(ratingAvgPath.options.default, 0);
  assert.equal(ratingAvgPath.options.min, 0);
  assert.equal(ratingAvgPath.options.max, 5);

  const countPath = Doctor.schema.path('reviewCount');
  assert.ok(countPath, 'reviewCount should exist on Doctor schema');
  assert.equal(countPath.instance, 'Number');
  assert.equal(countPath.options.default, 0);
  assert.equal(countPath.options.min, 0);
});

// ---------------------------------------------------------------------------
// 2. Cancellation Controller Validation Tests
// ---------------------------------------------------------------------------

const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
};

test('cancelAppointment rejects missing, empty, or whitespace-only reason for patient', async () => {
  const patientId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  // Stub loadAppointment and getActor via Appointment.findById
  const originalFindById = Appointment.findById;
  Appointment.findById = async () => ({
    _id: appointmentId,
    patient: patientId,
    status: 'booked',
    populate: async () => {},
    save: async () => {},
  });

  try {
    // Missing body
    const req1 = {
      params: { id: appointmentId.toString() },
      body: {},
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => cancelAppointment(req1, createMockRes()),
      (err) => err.status === 400 && err.message === 'Cancellation reason is required'
    );

    // Whitespace only
    const req2 = {
      params: { id: appointmentId.toString() },
      body: { cancellationReason: '     ' },
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => cancelAppointment(req2, createMockRes()),
      (err) => err.status === 400 && err.message === 'Cancellation reason is required'
    );

    // Non-string
    const req3 = {
      params: { id: appointmentId.toString() },
      body: { cancellationReason: 12345 },
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => cancelAppointment(req3, createMockRes()),
      (err) => err.status === 400 && err.message === 'Cancellation reason is required'
    );

    // Oversized (> 500 characters)
    const req4 = {
      params: { id: appointmentId.toString() },
      body: { cancellationReason: 'x'.repeat(501) },
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => cancelAppointment(req4, createMockRes()),
      (err) => err.status === 400 && err.message === 'Cancellation reason must be under 500 characters'
    );
  } finally {
    Appointment.findById = originalFindById;
  }
});

test('cancelAppointment rejects unauthorized cancellation when patient does not own appointment', async () => {
  const ownerId = new mongoose.Types.ObjectId();
  const otherPatientId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  const originalFindById = Appointment.findById;
  Appointment.findById = async () => ({
    _id: appointmentId,
    patient: ownerId,
    status: 'booked',
  });

  try {
    const req = {
      params: { id: appointmentId.toString() },
      body: { cancellationReason: 'Valid reason' },
      user: { _id: otherPatientId, role: 'patient' },
    };
    await assert.rejects(
      async () => cancelAppointment(req, createMockRes()),
      (err) => err.status === 403 && err.message === 'You are not allowed to cancel this appointment'
    );
  } finally {
    Appointment.findById = originalFindById;
  }
});

test('cancelAppointment rejects cancellation for non-booked appointments', async () => {
  const patientId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  const originalFindById = Appointment.findById;
  Appointment.findById = async () => ({
    _id: appointmentId,
    patient: patientId,
    status: 'completed',
  });

  try {
    const req = {
      params: { id: appointmentId.toString() },
      body: { cancellationReason: 'Valid reason' },
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => cancelAppointment(req, createMockRes()),
      (err) => err.status === 409 && err.message.includes('Only booked appointments can be cancelled')
    );
  } finally {
    Appointment.findById = originalFindById;
  }
});

// ---------------------------------------------------------------------------
// 3. Review Controller Validation Tests
// ---------------------------------------------------------------------------

test('submitAppointmentReview rejects invalid ratings (missing, out-of-range, fractional, string)', async () => {
  const patientId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  const testCases = [
    { body: {}, expectedMsg: 'Rating is required' },
    { body: { rating: null }, expectedMsg: 'Rating is required' },
    { body: { rating: 0 }, expectedMsg: 'Rating must be an integer between 1 and 5' },
    { body: { rating: 6 }, expectedMsg: 'Rating must be an integer between 1 and 5' },
    { body: { rating: -1 }, expectedMsg: 'Rating must be an integer between 1 and 5' },
    { body: { rating: 3.5 }, expectedMsg: 'Rating must be an integer between 1 and 5' },
    { body: { rating: '5' }, expectedMsg: 'Rating must be an integer between 1 and 5' },
    { body: { rating: 5, comment: 123 }, expectedMsg: 'Comment must be a string' },
    { body: { rating: 5, comment: 'a'.repeat(1001) }, expectedMsg: 'Comment must be under 1000 characters' },
  ];

  for (const tc of testCases) {
    const req = {
      params: { id: appointmentId.toString() },
      body: tc.body,
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => submitAppointmentReview(req, createMockRes()),
      (err) => err.status === 400 && err.message === tc.expectedMsg,
      `Should reject with message "${tc.expectedMsg}" for body ${JSON.stringify(tc.body)}`
    );
  }
});

test('submitAppointmentReview rejects non-completed appointments', async () => {
  const patientId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  const originalFindById = Appointment.findById;
  Appointment.findById = async () => ({
    _id: appointmentId,
    patient: patientId,
    status: 'booked',
  });

  try {
    const req = {
      params: { id: appointmentId.toString() },
      body: { rating: 5, comment: 'Great!' },
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => submitAppointmentReview(req, createMockRes()),
      (err) => err.status === 409 && err.message.includes('Only completed appointments can be reviewed')
    );
  } finally {
    Appointment.findById = originalFindById;
  }
});

test('submitAppointmentReview rejects patient reviewing another patient appointment', async () => {
  const ownerId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  const originalFindById = Appointment.findById;
  Appointment.findById = async () => ({
    _id: appointmentId,
    patient: ownerId,
    status: 'completed',
  });

  try {
    const req = {
      params: { id: appointmentId.toString() },
      body: { rating: 5 },
      user: { _id: otherId, role: 'patient' },
    };
    await assert.rejects(
      async () => submitAppointmentReview(req, createMockRes()),
      (err) => err.status === 403 && err.message === 'You can only review your own appointments'
    );
  } finally {
    Appointment.findById = originalFindById;
  }
});

test('submitAppointmentReview rejects duplicate reviews for already reviewed appointment', async () => {
  const patientId = new mongoose.Types.ObjectId();
  const appointmentId = new mongoose.Types.ObjectId();

  const originalFindById = Appointment.findById;
  Appointment.findById = async () => ({
    _id: appointmentId,
    patient: patientId,
    status: 'completed',
    review: {
      rating: 4,
      comment: 'Initial review',
    },
  });

  try {
    const req = {
      params: { id: appointmentId.toString() },
      body: { rating: 5, comment: 'Trying to review again' },
      user: { _id: patientId, role: 'patient' },
    };
    await assert.rejects(
      async () => submitAppointmentReview(req, createMockRes()),
      (err) => err.status === 409 && err.message === 'This consultation has already been reviewed'
    );
  } finally {
    Appointment.findById = originalFindById;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { normalizeApiUrl } from '../src/api/axios.js';

test('Axios endpoint URL resolution for cancellation and review endpoints', () => {
  const baseURL = normalizeApiUrl('https://hospital-appointment-platform.onrender.com');
  const instance = axios.create({ baseURL });

  const apptId = '654321654321654321654321';
  assert.equal(
    instance.getUri({ url: `/appointments/${apptId}/cancel` }),
    `https://hospital-appointment-platform.onrender.com/api/appointments/${apptId}/cancel`
  );
  assert.equal(
    instance.getUri({ url: `/appointments/${apptId}/review` }),
    `https://hospital-appointment-platform.onrender.com/api/appointments/${apptId}/review`
  );
});

// Validation helper tests matching frontend input validation
const validateCancellationReason = (reason) => {
  if (typeof reason !== 'string') return { valid: false, error: 'Reason must be a string' };
  const trimmed = reason.trim();
  if (!trimmed) return { valid: false, error: 'Cancellation reason is required' };
  if (trimmed.length > 500) return { valid: false, error: 'Cancellation reason must be under 500 characters' };
  return { valid: true, value: trimmed };
};

test('validateCancellationReason validates patient cancellation reason', () => {
  assert.deepEqual(validateCancellationReason(''), { valid: false, error: 'Cancellation reason is required' });
  assert.deepEqual(validateCancellationReason('   '), { valid: false, error: 'Cancellation reason is required' });
  assert.deepEqual(validateCancellationReason(null), { valid: false, error: 'Reason must be a string' });
  assert.deepEqual(validateCancellationReason(undefined), { valid: false, error: 'Reason must be a string' });

  const oversized = 'a'.repeat(501);
  assert.deepEqual(validateCancellationReason(oversized), { valid: false, error: 'Cancellation reason must be under 500 characters' });

  const exactlyMax = 'a'.repeat(500);
  assert.deepEqual(validateCancellationReason(exactlyMax), { valid: true, value: exactlyMax });

  const valid = '   Feeling much better, no longer needed   ';
  assert.deepEqual(validateCancellationReason(valid), { valid: true, value: 'Feeling much better, no longer needed' });
});

const validateReviewInput = (rating, comment = '') => {
  if (rating === undefined || rating === null) {
    return { valid: false, error: 'Rating is required' };
  }
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { valid: false, error: 'Rating must be an integer between 1 and 5' };
  }
  if (typeof comment !== 'string') {
    return { valid: false, error: 'Comment must be a string' };
  }
  if (comment.length > 1000) {
    return { valid: false, error: 'Comment must be under 1000 characters' };
  }
  return { valid: true, rating, comment: comment.trim() };
};

test('validateReviewInput enforces 1-5 integer ratings and optional comment max length', () => {
  // Valid ratings
  assert.equal(validateReviewInput(1).valid, true);
  assert.equal(validateReviewInput(5).valid, true);
  assert.equal(validateReviewInput(3, 'Great consultation').valid, true);

  // Invalid ratings
  assert.equal(validateReviewInput(0).valid, false);
  assert.equal(validateReviewInput(6).valid, false);
  assert.equal(validateReviewInput(-1).valid, false);
  assert.equal(validateReviewInput(3.5).valid, false);
  assert.equal(validateReviewInput('5').valid, false);
  assert.equal(validateReviewInput(null).valid, false);
  assert.equal(validateReviewInput(undefined).valid, false);

  // Invalid comment
  assert.equal(validateReviewInput(5, 'c'.repeat(1001)).valid, false);
  assert.equal(validateReviewInput(5, 'c'.repeat(1000)).valid, true);
});

test('Appointment action rendering states for patient view', () => {
  const getActionsForAppointment = (appt) => {
    if (appt.status === 'booked') return 'CAN_CANCEL';
    if (appt.status === 'completed') {
      return appt.review?.rating ? 'REVIEWED' : 'CAN_REVIEW';
    }
    if (appt.status === 'cancelled') return 'CANCELLED';
    return 'NONE';
  };

  assert.equal(getActionsForAppointment({ status: 'booked' }), 'CAN_CANCEL');
  assert.equal(getActionsForAppointment({ status: 'completed' }), 'CAN_REVIEW');
  assert.equal(getActionsForAppointment({ status: 'completed', review: { rating: 5 } }), 'REVIEWED');
  assert.equal(getActionsForAppointment({ status: 'cancelled', cancellationReason: 'Rescheduling' }), 'CANCELLED');
});

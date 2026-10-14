import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { normalizeApiUrl } from '../src/api/axios.js';

test('normalizeApiUrl handles undefined and empty strings', () => {
  assert.equal(normalizeApiUrl(undefined), 'http://localhost:5000/api');
  assert.equal(normalizeApiUrl(''), 'http://localhost:5000/api');
  assert.equal(normalizeApiUrl('   '), 'http://localhost:5000/api');
});

test('normalizeApiUrl appends /api if missing from domain', () => {
  assert.equal(
    normalizeApiUrl('https://hospital-appointment-platform.onrender.com'),
    'https://hospital-appointment-platform.onrender.com/api'
  );
  assert.equal(
    normalizeApiUrl('https://hospital-appointment-platform.onrender.com/'),
    'https://hospital-appointment-platform.onrender.com/api'
  );
  assert.equal(normalizeApiUrl('http://localhost:5000'), 'http://localhost:5000/api');
});

test('normalizeApiUrl preserves /api if already present', () => {
  assert.equal(
    normalizeApiUrl('https://hospital-appointment-platform.onrender.com/api'),
    'https://hospital-appointment-platform.onrender.com/api'
  );
  assert.equal(
    normalizeApiUrl('https://hospital-appointment-platform.onrender.com/api/'),
    'https://hospital-appointment-platform.onrender.com/api'
  );
  assert.equal(normalizeApiUrl('http://localhost:5000/api'), 'http://localhost:5000/api');
  assert.equal(normalizeApiUrl('http://localhost:5000/api/'), 'http://localhost:5000/api');
});

test('full Axios API endpoint URL resolution', () => {
  const baseURL = normalizeApiUrl('https://hospital-appointment-platform.onrender.com');

  const instance = axios.create({ baseURL });
  assert.equal(instance.getUri({ url: '/auth/register' }), 'https://hospital-appointment-platform.onrender.com/api/auth/register');
  assert.equal(instance.getUri({ url: '/auth/login' }), 'https://hospital-appointment-platform.onrender.com/api/auth/login');
  assert.equal(instance.getUri({ url: '/auth/me' }), 'https://hospital-appointment-platform.onrender.com/api/auth/me');
  assert.equal(instance.getUri({ url: '/auth/refresh' }), 'https://hospital-appointment-platform.onrender.com/api/auth/refresh');
  assert.equal(instance.getUri({ url: '/auth/logout' }), 'https://hospital-appointment-platform.onrender.com/api/auth/logout');
  assert.equal(instance.getUri({ url: '/auth/logout-all' }), 'https://hospital-appointment-platform.onrender.com/api/auth/logout-all');
  assert.equal(instance.getUri({ url: '/auth/sessions' }), 'https://hospital-appointment-platform.onrender.com/api/auth/sessions');
  assert.equal(instance.getUri({ url: '/admin/audit-logs' }), 'https://hospital-appointment-platform.onrender.com/api/admin/audit-logs');
  assert.equal(instance.getUri({ url: '/appointments' }), 'https://hospital-appointment-platform.onrender.com/api/appointments');
  assert.equal(instance.getUri({ url: '/doctors' }), 'https://hospital-appointment-platform.onrender.com/api/doctors');
  assert.equal(instance.getUri({ url: '/departments' }), 'https://hospital-appointment-platform.onrender.com/api/departments');
  assert.equal(instance.getUri({ url: '/waiting-list' }), 'https://hospital-appointment-platform.onrender.com/api/waiting-list');
});

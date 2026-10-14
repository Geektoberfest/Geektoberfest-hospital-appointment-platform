'use strict';

/**
 * Unit tests for Issue #11 – SSE notification service and controller helpers.
 *
 * Run: npm test  (from backend/)
 * Uses Node.js built-in test runner (node:test) – no external test framework required.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ─── notificationService ───────────────────────────────────────────────────

describe('notificationService', () => {
  let svc;
  before(() => {
    svc = require('../services/notificationService');
  });

  it('connectionCount returns 0 when no connections are registered', () => {
    assert.equal(svc.connectionCount(), 0);
  });

  it('addConnection registers a connection and connectionCount increments', () => {
    const fakeRes = { on: () => {}, write: () => {}, flush: () => {} };
    svc.addConnection('user-1', fakeRes);
    assert.equal(svc.connectionCount(), 1);

    // Clean up so subsequent tests start fresh.
    svc.removeConnection('user-1', fakeRes);
    assert.equal(svc.connectionCount(), 0);
  });

  it('removeConnection on unknown user is a no-op (does not throw)', () => {
    assert.doesNotThrow(() => svc.removeConnection('nonexistent', {}));
  });

  it('notifyUser is a no-op when the user has no open connection', () => {
    // Should not throw even though no connection exists.
    assert.doesNotThrow(() => svc.notifyUser('no-such-user', 'ping', { ok: true }));
  });

  it('notifyUser writes the correct SSE payload to all open connections', () => {
    const written = [];
    const fakeRes = {
      on: () => {},
      write: (chunk) => written.push(chunk),
      flush: () => {},
    };

    svc.addConnection('patient-42', fakeRes);
    svc.notifyUser('patient-42', 'waitlist.assigned', { message: 'hi' });

    assert.equal(written.length, 1);
    assert.ok(written[0].startsWith('event: waitlist.assigned\n'), 'SSE event line correct');
    assert.ok(written[0].includes('"message":"hi"'), 'SSE data line contains payload');

    svc.removeConnection('patient-42', fakeRes);
  });

  it('notifyUser silently swallows write errors', () => {
    const throwingRes = {
      on: () => {},
      write: () => { throw new Error('pipe broken'); },
      flush: () => {},
    };

    svc.addConnection('patient-99', throwingRes);
    assert.doesNotThrow(() =>
      svc.notifyUser('patient-99', 'test', {})
    );
    svc.removeConnection('patient-99', throwingRes);
  });
});

// ─── notificationController helpers ────────────────────────────────────────

describe('notificationController – ticket store', () => {
  /**
   * The ticket store is internal to the module; we test it indirectly by
   * simulating the issueTicket / streamSSE flow with fake req/res objects.
   */
  let ctrl;
  before(() => {
    // Stub environment so the module loads cleanly without a real JWT_SECRET check.
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    ctrl = require('../controllers/notificationController');
  });

  it('issueTicket creates a ticket and responds with 200 + { ticket }', async () => {
    let statusCode;
    let body;
    const req = { user: { _id: 'user-abc' } };
    const res = {
      status(s) { statusCode = s; return this; },
      json(b) { body = b; return this; },
    };

    await ctrl.issueTicket(req, res, (err) => { throw err; });

    assert.equal(statusCode, 200);
    assert.equal(body.success, true);
    assert.ok(typeof body.data.ticket === 'string' && body.data.ticket.length > 0,
      'ticket should be a non-empty string');
  });

  it('streamSSE rejects missing ticket with 400', async () => {
    const req = { query: {}, on: () => {} };
    let err;
    await ctrl.streamSSE(req, {}, (e) => { err = e; });
    assert.ok(err, 'should call next with an error');
    assert.equal(err.status, 400);
  });

  it('streamSSE rejects an unknown / expired ticket with 401', async () => {
    const req = { query: { ticket: 'totally-fake-ticket' }, on: () => {} };
    let err;
    await ctrl.streamSSE(req, {}, (e) => { err = e; });
    assert.ok(err, 'should call next with an error');
    assert.equal(err.status, 401);
  });
});

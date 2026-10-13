process.env.JWT_SECRET = 'test_secret_for_notification_tests_1234567890';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const notifications = require('../services/notificationService');
const tickets = require('../utils/sseTickets');

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const SESSION_A = '3f6c1f8e-0d2b-4a9c-9f7a-1b2c3d4e5f60';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withEnv = (t, key, value) => {
  const original = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
};

/** Minimal stand-in for an open SSE response. */
const makeRes = () => ({
  writableEnded: false,
  destroyed: false,
  finished: false,
  failWrite: false,
  chunks: [],
  write(chunk) {
    if (this.failWrite) throw new Error('EPIPE');
    this.chunks.push(chunk);
    return true;
  },
  end() {
    this.writableEnded = true;
  },
  text() {
    return this.chunks.join('');
  },
});

test.beforeEach(() => {
  notifications.closeAll();
  tickets.clearTickets();
});

test.after(() => {
  notifications.closeAll();
  tickets.clearTickets();
});

// ---------------------------------------------------------------------------
// Delivery and isolation
// ---------------------------------------------------------------------------

test('a connected patient receives their own event in SSE format and nobody else does', () => {
  const resA = makeRes();
  const resB = makeRes();
  assert.ok(notifications.addClient(USER_A, resA, { heartbeat: false }));
  assert.ok(notifications.addClient(USER_B, resB, { heartbeat: false }));

  const delivered = notifications.notifyUser(USER_A, 'waitlist.assigned', { appointmentId: 'apt-1', status: 'booked' });

  assert.equal(delivered, 1);
  assert.equal(resA.text(), 'event: waitlist.assigned\ndata: {"appointmentId":"apt-1","status":"booked"}\n\n');
  assert.equal(resB.text(), '', 'another patient must never receive the event');
});

test('every open connection of the same patient is served (multiple tabs)', () => {
  const tabs = [makeRes(), makeRes(), makeRes()];
  tabs.forEach((res) => assert.ok(notifications.addClient(USER_A, res, { heartbeat: false })));
  assert.equal(notifications.userConnectionCount(USER_A), 3);

  assert.equal(notifications.notifyUser(USER_A, 'waitlist.assigned', { appointmentId: 'apt-2' }), 3);
  for (const res of tabs) assert.match(res.text(), /event: waitlist\.assigned/);
});

test('object ids and strings address the same registrant', () => {
  const res = makeRes();
  notifications.addClient({ toHexString: () => USER_A }, res, { heartbeat: false });

  assert.equal(notifications.notifyUser(USER_A, 'waitlist.assigned', { appointmentId: 'apt-3' }), 1);
  assert.match(res.text(), /event: waitlist\.assigned/);
});

test('notifications to an unknown, empty or offline patient are a safe no-op', () => {
  assert.equal(notifications.notifyUser(USER_A, 'waitlist.assigned', {}), 0);
  assert.equal(notifications.notifyUser('', 'waitlist.assigned', {}), 0);
  assert.equal(notifications.notifyUser(null, 'waitlist.assigned', {}), 0);
  assert.equal(notifications.notifyUser(USER_A, '', {}), 0);
  assert.equal(notifications.notifyUser(USER_A, null, {}), 0);
  assert.equal(notifications.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// Disconnect handling and failure tolerance
// ---------------------------------------------------------------------------

test('a disconnected connection is pruned instead of being written to', () => {
  const res = makeRes();
  notifications.addClient(USER_A, res, { heartbeat: false });

  res.destroyed = true; // the socket went away between frames

  assert.equal(notifications.notifyUser(USER_A, 'waitlist.assigned', { appointmentId: 'apt-4' }), 0);
  assert.equal(res.chunks.length, 0, 'nothing may be written to a destroyed response');
  assert.equal(notifications.userConnectionCount(USER_A), 0, 'the dead connection must be removed');
  assert.equal(notifications.connectionCount(), 0);
});

test('a stream that fails mid-write is dropped without crashing the caller', () => {
  const broken = makeRes();
  const healthy = makeRes();
  notifications.addClient(USER_A, broken, { heartbeat: false });
  notifications.addClient(USER_A, healthy, { heartbeat: false });
  broken.failWrite = true;

  assert.doesNotThrow(() => notifications.notifyUser(USER_A, 'waitlist.assigned', { appointmentId: 'apt-5' }));
  assert.equal(notifications.notifyUser(USER_A, 'waitlist.assigned', { appointmentId: 'apt-6' }), 1);
  assert.equal(notifications.userConnectionCount(USER_A), 1, 'only the failing connection is removed');
});

test('removeClient is idempotent and stops delivery', () => {
  const res = makeRes();
  const client = notifications.addClient(USER_A, res, { heartbeat: false });

  assert.equal(notifications.removeClient(client), true);
  assert.equal(notifications.removeClient(client), false);
  assert.equal(notifications.removeClient(null), false);
  assert.equal(notifications.notifyUser(USER_A, 'waitlist.assigned', {}), 0);
  assert.equal(notifications.connectionCount(), 0);
});

test('a response that is already finished is never registered', () => {
  const res = makeRes();
  res.writableEnded = true;
  assert.equal(notifications.addClient(USER_A, res, { heartbeat: false }), null);
  assert.equal(notifications.addClient('', makeRes(), { heartbeat: false }), null);
  assert.equal(notifications.connectionCount(), 0);
});

test('removeUser closes every stream of one patient only', () => {
  const resA = makeRes();
  const resB = makeRes();
  notifications.addClient(USER_A, resA, { heartbeat: false });
  notifications.addClient(USER_A, makeRes(), { heartbeat: false });
  notifications.addClient(USER_B, resB, { heartbeat: false });

  assert.equal(notifications.removeUser(USER_A), 2);
  assert.equal(resA.writableEnded, true);
  assert.equal(notifications.userConnectionCount(USER_A), 0);
  assert.equal(notifications.userConnectionCount(USER_B), 1);
});

test('the per-user connection list is bounded and evicts the oldest stream', () => {
  const first = makeRes();
  const registered = [notifications.addClient(USER_A, first, { heartbeat: false })];
  for (let i = 1; i < notifications.MAX_CONNECTIONS_PER_USER; i += 1) {
    registered.push(notifications.addClient(USER_A, makeRes(), { heartbeat: false }));
  }
  assert.equal(notifications.userConnectionCount(USER_A), notifications.MAX_CONNECTIONS_PER_USER);

  // One more tab pushes out the oldest connection rather than growing without bound.
  notifications.addClient(USER_A, makeRes(), { heartbeat: false });
  assert.equal(notifications.userConnectionCount(USER_A), notifications.MAX_CONNECTIONS_PER_USER);
  assert.equal(notifications.removeClient(registered[0]), false, 'the oldest stream was evicted');
  assert.equal(first.writableEnded, true);
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

test('heartbeats are plain comments sent on the configured interval and cleared on disconnect', async (t) => {
  withEnv(t, 'SSE_HEARTBEAT_MS', '15');
  assert.equal(notifications.heartbeatMs(), 15);

  const res = makeRes();
  const client = notifications.addClient(USER_A, res);
  await sleep(60);

  const beats = res.chunks.filter((chunk) => chunk.startsWith(': '));
  assert.ok(beats.length >= 2, `expected heartbeats, received ${JSON.stringify(res.chunks)}`);
  assert.ok(beats.every((chunk) => chunk === ': ping\n\n'));
  assert.equal(res.text().includes('event:'), false, 'heartbeats must not look like notifications');
  assert.equal(client.heartbeatTimer?.hasRef?.(), false, 'heartbeats must not keep the process alive');

  const seen = res.chunks.length;
  notifications.removeClient(client);
  await sleep(50);
  assert.equal(res.chunks.length, seen, 'the heartbeat timer must be cleared on disconnect');
});

test('the default heartbeat interval is 25 seconds', (t) => {
  const original = process.env.SSE_HEARTBEAT_MS;
  delete process.env.SSE_HEARTBEAT_MS;
  t.after(() => {
    if (original !== undefined) process.env.SSE_HEARTBEAT_MS = original;
  });
  assert.equal(notifications.heartbeatMs(), 25000);
  assert.equal(notifications.DEFAULT_HEARTBEAT_MS, 25000);
});

test('closeAll detaches every stream', () => {
  notifications.addClient(USER_A, makeRes(), { heartbeat: false });
  notifications.addClient(USER_B, makeRes(), { heartbeat: false });
  assert.equal(notifications.connectionCount(), 2);
  assert.equal(notifications.closeAll(), 2);
  assert.equal(notifications.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

test('a ticket is issued once, bound to a user and consumed exactly once', () => {
  const issued = tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });

  assert.match(issued.ticket, tickets.TICKET_VALUE_RE);
  assert.equal(issued.expiresIn, tickets.DEFAULT_TICKET_TTL_MS);
  assert.equal(tickets.ticketCount(), 1);

  const claim = tickets.consumeTicket(issued.ticket);
  assert.deepEqual(claim, { userId: USER_A, sessionId: SESSION_A });
  assert.equal(tickets.consumeTicket(issued.ticket), null, 'a ticket cannot be used twice');
  assert.equal(tickets.ticketCount(), 0);
});

test('tickets are random, stored only as a hash and never guessable from the store', () => {
  const first = tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });
  const second = tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });

  assert.notEqual(first.ticket, second.ticket);
  assert.equal(tickets.ticketCount(), 2);

  // The stored key is the SHA-256 hash, not the value handed to the client.
  assert.match(tickets.hashTicket(first.ticket), /^[0-9a-f]{64}$/);
  assert.notEqual(tickets.hashTicket(first.ticket), first.ticket);
  // Presenting the *hash* is not presenting the ticket.
  assert.equal(tickets.consumeTicket(tickets.hashTicket(first.ticket)), null);
  // Both raw tickets are still usable exactly once.
  assert.ok(tickets.consumeTicket(first.ticket));
  assert.ok(tickets.consumeTicket(second.ticket));
});

test('a ticket cannot be issued without a user identity', () => {
  assert.equal(tickets.issueTicket({ userId: '', sessionId: SESSION_A }), null);
  assert.equal(tickets.issueTicket({ userId: null, sessionId: SESSION_A }), null);
  assert.equal(tickets.issueTicket({}), null);
  assert.equal(tickets.issueTicket(), null);
  assert.equal(tickets.ticketCount(), 0);
});

test('object ids can be used as the ticket owner', () => {
  const issued = tickets.issueTicket({ userId: { toHexString: () => USER_A }, sessionId: SESSION_A });
  assert.equal(tickets.consumeTicket(issued.ticket).userId, USER_A);
});

test('malformed tickets are rejected before the store is touched', () => {
  tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });
  const before = tickets.ticketCount();

  for (const bad of [undefined, null, '', '   ', 'short', 'a'.repeat(200), 42, {}, [], ['ticket'], 'not a ticket value']) {
    assert.equal(tickets.consumeTicket(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(tickets.ticketCount(), before);
});

test('an expired ticket is rejected and burned rather than left reusable', async (t) => {
  withEnv(t, 'SSE_TICKET_TTL_MS', '5');
  const issued = tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });
  assert.equal(issued.expiresIn, 5);

  await sleep(25);

  assert.equal(tickets.consumeTicket(issued.ticket), null);
  assert.equal(tickets.ticketCount(), 0, 'the expired entry is gone');
});

test('concurrent consumption of one ticket has exactly one winner', async () => {
  const issued = tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => Promise.resolve().then(() => tickets.consumeTicket(issued.ticket)))
  );

  assert.equal(results.filter(Boolean).length, 1, 'only one caller may claim a ticket');
  assert.equal(results.filter((r) => r === null).length, 7);
});

test('the ticket store stays bounded and drops the oldest entries', (t) => {
  withEnv(t, 'SSE_MAX_TICKETS', '3');

  const issued = [];
  for (let i = 0; i < 5; i += 1) issued.push(tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A }).ticket);

  assert.equal(tickets.ticketCount(), 3);
  assert.equal(tickets.consumeTicket(issued[0]), null, 'the oldest ticket was dropped');
  assert.equal(tickets.consumeTicket(issued[1]), null);
  assert.ok(tickets.consumeTicket(issued[4]), 'the newest tickets remain usable');
});

test('issuing a ticket sweeps entries that have already expired', async (t) => {
  withEnv(t, 'SSE_TICKET_TTL_MS', '5');
  const stale = tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });
  await sleep(20);

  withEnv(t, 'SSE_TICKET_TTL_MS', '30000');
  tickets.issueTicket({ userId: USER_B, sessionId: SESSION_A });

  assert.equal(tickets.ticketCount(), 1, 'the expired entry was swept away');
  assert.equal(tickets.consumeTicket(stale.ticket), null);
});

test('sweepExpired reports how many tickets it discarded', async (t) => {
  withEnv(t, 'SSE_TICKET_TTL_MS', '5');
  tickets.issueTicket({ userId: USER_A, sessionId: SESSION_A });
  tickets.issueTicket({ userId: USER_B, sessionId: SESSION_A });
  await sleep(20);
  assert.equal(tickets.sweepExpired(), 2);
  assert.equal(tickets.ticketCount(), 0);
});

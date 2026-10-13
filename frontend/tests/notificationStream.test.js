import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSIGNED_EVENT,
  BACKOFF_SCHEDULE_MS,
  MAX_TRACKED_NOTIFICATIONS,
  createNotificationStream,
  mergeNotification,
  nextBackoffMs,
  parseAssignment,
  streamUrl,
} from '../src/api/notificationStream.js';

/** Minimal EventSource stand-in so the lifecycle can be driven deterministically. */
class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.handlers = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, handler) {
    this.handlers[type] = [...(this.handlers[type] || []), handler];
  }

  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter((h) => h !== handler);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  // --- test drivers -------------------------------------------------------
  open() {
    this.readyState = 1;
    this.emit('open');
  }

  fail() {
    this.readyState = 0;
    this.emit('error');
  }

  emitAssigned(payload) {
    this.emit(ASSIGNED_EVENT, { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  emit(type, event) {
    for (const handler of [...(this.handlers[type] || [])]) handler(event);
  }
}

/** Deterministic timer queue instead of real delays. */
const makeScheduler = () => {
  const queue = [];
  return {
    setTimeout: (fn, delay) => {
      const entry = { fn, delay };
      queue.push(entry);
      return entry;
    },
    clearTimeout: (entry) => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
    },
    delays: () => queue.map((entry) => entry.delay),
    size: () => queue.length,
    async runNext() {
      const entry = queue.shift();
      if (!entry) return false;
      entry.fn();
      await tick();
      return true;
    },
    async runAll() {
      let guard = 0;
      while (queue.length && guard < 50) {
        await this.runNext();
        guard += 1;
      }
      return guard;
    },
  };
};

/** Let pending promises (ticket requests) settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const makeHarness = (overrides = {}) => {
  FakeEventSource.instances = [];
  const scheduler = makeScheduler();
  const statuses = [];
  const received = [];
  const errors = [];
  const issued = [];
  const apiBase = 'http://api.test/api';

  let counter = 0;
  const stream = createNotificationStream({
    requestTicket: async () => {
      counter += 1;
      const ticket = `ticket-${counter}`;
      issued.push(ticket);
      return ticket;
    },
    createEventSource: (ticket) => new FakeEventSource(streamUrl(apiBase, ticket)),
    onNotification: (notification) => received.push(notification),
    onStatus: ({ state }) => statuses.push(state),
    onError: (err) => errors.push(err),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    ...overrides,
  });

  return {
    stream,
    scheduler,
    statuses,
    received,
    errors,
    issued,
    apiBase,
    sources: () => FakeEventSource.instances,
    latest: () => FakeEventSource.instances[FakeEventSource.instances.length - 1],
  };
};

test('the reconnect delays are bounded and non-decreasing', () => {
  assert.deepEqual(BACKOFF_SCHEDULE_MS, [1000, 2000, 5000, 10000, 20000, 30000]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(nextBackoffMs), [1000, 2000, 5000, 10000, 20000, 30000]);
  assert.equal(nextBackoffMs(7), 30000, 'the schedule never grows beyond its ceiling');
  assert.equal(nextBackoffMs(99), 30000);
  assert.equal(nextBackoffMs(0), 1000);
  assert.equal(nextBackoffMs(undefined), 1000);
  assert.equal(nextBackoffMs('3'), 5000);
  assert.equal(nextBackoffMs(-4), 1000);
});

test('the stream URL targets the API origin and always encodes the ticket', () => {
  assert.equal(streamUrl('http://localhost:5000/api', 'abc123'), 'http://localhost:5000/api/notifications/stream?ticket=abc123');
  assert.equal(streamUrl('http://localhost:5000/api/', 'abc123'), 'http://localhost:5000/api/notifications/stream?ticket=abc123');
  assert.equal(streamUrl('https://api.example.com/api', 'a b/c?d=1&e'), 'https://api.example.com/api/notifications/stream?ticket=a%20b%2Fc%3Fd%3D1%26e');
  assert.equal(streamUrl('', 't').startsWith('/notifications/stream'), true);
  assert.equal(streamUrl('http://x/api', undefined), 'http://x/api/notifications/stream?ticket=');
});

test('parseAssignment accepts only complete, well-shaped assignments', () => {
  const valid = parseAssignment(
    JSON.stringify({
      appointmentId: 'apt-1',
      waitingListEntryId: 'wl-1',
      date: '2099-06-15',
      startTime: '10:00',
      endTime: '10:30',
      doctorName: 'Asha Rao',
      specialization: 'Cardiology',
      status: 'booked',
    })
  );

  assert.deepEqual(valid, {
    appointmentId: 'apt-1',
    waitingListEntryId: 'wl-1',
    date: '2099-06-15',
    startTime: '10:00',
    endTime: '10:30',
    doctorName: 'Asha Rao',
    specialization: 'Cardiology',
    status: 'booked',
  });
});

test('parseAssignment normalizes missing fields and drops anything unexpected', () => {
  const parsed = parseAssignment(
    JSON.stringify({ appointmentId: 'apt-2', patientEmail: 'secret@example.com', accessToken: 'abc', notes: 'private' })
  );

  assert.deepEqual(parsed, {
    appointmentId: 'apt-2',
    waitingListEntryId: '',
    date: '',
    startTime: '',
    endTime: '',
    doctorName: '',
    specialization: '',
    status: 'booked',
  });
  // Unknown/sensitive frame fields are not carried into the UI state.
  assert.deepEqual(Object.keys(parsed).sort(), [
    'appointmentId',
    'date',
    'doctorName',
    'endTime',
    'specialization',
    'startTime',
    'status',
    'waitingListEntryId',
  ]);
});

test('parseAssignment never throws on malformed frames', () => {
  for (const bad of [
    undefined,
    null,
    '',
    '   ',
    'not json at all',
    '{',
    'null',
    '[]',
    '[{"appointmentId":"apt"}]',
    '"a string"',
    '42',
    '{}',
    '{"appointmentId":42}',
    '{"appointmentId":""}',
    '{"appointmentId":null}',
  ]) {
    assert.equal(parseAssignment(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('mergeNotification deduplicates by appointment and keeps the list bounded', () => {
  const first = { appointmentId: 'apt-1', doctorName: 'A' };
  const second = { appointmentId: 'apt-2', doctorName: 'B' };

  let list = mergeNotification([], first);
  list = mergeNotification(list, second);
  assert.deepEqual(list.map((n) => n.appointmentId), ['apt-2', 'apt-1']);

  // Re-delivery after a reconnect replaces the entry instead of duplicating it.
  const refreshed = { appointmentId: 'apt-1', doctorName: 'A (updated)' };
  list = mergeNotification(list, refreshed);
  assert.deepEqual(list.map((n) => n.appointmentId), ['apt-1', 'apt-2']);
  assert.equal(list[0].doctorName, 'A (updated)');
  assert.equal(list.length, 2);

  // Bounded growth.
  let many = [];
  for (let i = 0; i < 30; i += 1) many = mergeNotification(many, { appointmentId: `apt-${i}` });
  assert.equal(many.length, MAX_TRACKED_NOTIFICATIONS);
  assert.equal(many[0].appointmentId, 'apt-29');

  // Defensive against junk.
  assert.deepEqual(mergeNotification(null, null), []);
  assert.deepEqual(mergeNotification([first], { doctorName: 'no id' }), [first]);
});

test('a signed-in patient opens one stream with a ticket and receives the assignment', async () => {
  const h = makeHarness();

  h.stream.start();
  await tick();

  assert.equal(h.issued.length, 1, 'a ticket is requested once');
  assert.equal(h.sources().length, 1);
  assert.equal(h.latest().url, `${h.apiBase}/notifications/stream?ticket=ticket-1`);
  assert.equal(h.statuses[0], 'connecting');

  // start() is idempotent: a second call must not open a second connection.
  h.stream.start();
  await tick();
  assert.equal(h.sources().length, 1);
  assert.equal(h.issued.length, 1);

  h.latest().open();
  assert.equal(h.statuses.at(-1), 'connected');

  h.latest().emitAssigned({ appointmentId: 'apt-1', date: '2099-06-15', startTime: '10:00', doctorName: 'Asha Rao' });
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0].appointmentId, 'apt-1');
  assert.equal(h.received[0].doctorName, 'Asha Rao');

  h.stream.stop();
  assert.equal(h.latest().closed, true);
});

test('malformed events never reach the UI and never throw', async () => {
  const h = makeHarness();
  h.stream.start();
  await tick();

  const source = h.latest();
  source.emitAssigned('{not json');
  source.emitAssigned({});
  source.emitAssigned({ appointmentId: 42 });
  source.emit('message', { data: '{"appointmentId":"ignored"}' }); // a different event name
  source.emit(ASSIGNED_EVENT, undefined);

  assert.equal(h.received.length, 0, 'nothing actionable may be surfaced');
  assert.ok(h.errors.length >= 3, 'malformed frames are reported, not swallowed');
  assert.equal(h.stream.isRunning(), true, 'the stream stays open');

  h.stream.stop();
});

test('a dropped stream reconnects with a fresh ticket and a growing backoff', async () => {
  const h = makeHarness();
  h.stream.start();
  await tick();
  const first = h.latest();

  first.fail();

  assert.equal(first.closed, true, 'the spent connection is closed before retrying');
  assert.deepEqual(h.scheduler.delays(), [1000]);
  assert.equal(h.statuses.at(-1), 'reconnecting');

  await h.scheduler.runNext();

  assert.equal(h.issued.length, 2, 'reconnecting always requests a new single-use ticket');
  assert.equal(h.sources().length, 2);
  assert.equal(h.latest().url, `${h.apiBase}/notifications/stream?ticket=ticket-2`);
  assert.notEqual(h.latest().url, first.url);

  // Still unreachable: the delay grows instead of hammering the backend.
  h.latest().fail();
  assert.deepEqual(h.scheduler.delays(), [2000]);

  await h.scheduler.runNext();
  h.latest().fail();
  assert.deepEqual(h.scheduler.delays(), [5000]);

  h.stream.stop();
});

test('one successful connection resets the backoff', async () => {
  const h = makeHarness();
  h.stream.start();
  await tick();

  h.latest().fail();
  assert.deepEqual(h.scheduler.delays(), [1000]);
  await h.scheduler.runNext();

  h.latest().open(); // healthy again
  h.latest().fail();
  assert.deepEqual(h.scheduler.delays(), [1000], 'the schedule restarts from the shortest delay');

  h.stream.stop();
});

test('an unavailable backend retries with backoff but stop() ends the loop', async () => {
  let attempts = 0;
  const h = makeHarness({
    requestTicket: async () => {
      attempts += 1;
      throw new Error('network down');
    },
  });

  h.stream.start();
  await tick();

  assert.equal(attempts, 1);
  assert.equal(h.sources().length, 0, 'no stream without a ticket');
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.scheduler.delays(), [1000]);

  await h.scheduler.runNext();
  assert.equal(attempts, 2);
  assert.deepEqual(h.scheduler.delays(), [2000]);
  await h.scheduler.runNext();
  await h.scheduler.runNext();
  assert.equal(attempts, 4);
  assert.deepEqual(h.scheduler.delays(), [10000]);

  // Logging out / unmounting must not leave a retry loop behind.
  h.stream.stop();
  assert.equal(h.scheduler.size(), 0);
  assert.equal(h.stream.isRunning(), false);

  await tick();
  assert.equal(attempts, 4, 'no further ticket requests after stop()');
  assert.equal(h.stream.currentAttempt(), 0);
});

test('stopping before the ticket resolves drops the pending connection', async () => {
  let resolveTicket;
  const pending = new Promise((resolve) => {
    resolveTicket = resolve;
  });
  const h = makeHarness({ requestTicket: () => pending });

  h.stream.start();
  await tick();
  assert.equal(h.sources().length, 0);

  h.stream.stop();
  resolveTicket('ticket-late');
  await tick();

  assert.equal(h.sources().length, 0, 'a stream must never open after unmount/logout');
  assert.equal(h.scheduler.size(), 0);
});

test('events that arrive after stop() are ignored', async () => {
  const h = makeHarness();
  h.stream.start();
  await tick();

  const source = h.latest();
  source.fail(); // queues a retry
  h.stream.stop();

  source.emitAssigned({ appointmentId: 'apt-late' });
  source.emit('open');

  assert.equal(h.received.length, 0);
  assert.equal(h.errors.length, 1, 'only the disconnect that happened while running is reported');
  assert.equal(h.statuses.at(-1), 'stopped');
  assert.equal(h.scheduler.size(), 0);
});

test('an empty or unusable ticket is retried instead of opening a broken stream', async () => {
  const h = makeHarness({ requestTicket: async () => '' });

  h.stream.start();
  await tick();

  assert.equal(h.sources().length, 0);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.scheduler.delays(), [1000]);

  h.stream.stop();
});

test('a throwing EventSource factory is contained and retried', async () => {
  const h = makeHarness({
    createEventSource: () => {
      throw new Error('EventSource unavailable');
    },
  });

  h.stream.start();
  await tick();

  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.scheduler.delays(), [1000]);
  assert.equal(h.stream.isRunning(), true);

  h.stream.stop();
  assert.equal(h.scheduler.size(), 0);
});

test('stop() is idempotent and closes the current connection once', async () => {
  const h = makeHarness();
  h.stream.start();
  await tick();

  const source = h.latest();
  h.stream.stop();
  h.stream.stop();

  assert.equal(source.closed, true);
  assert.equal(h.scheduler.size(), 0);
  assert.equal(h.statuses.at(-1), 'stopped');
});

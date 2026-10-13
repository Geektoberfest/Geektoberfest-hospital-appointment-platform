import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshManager, isRefreshExcluded, readCookie } from '../src/api/authSession.js';

test('isRefreshExcluded keeps auth endpoints out of the silent-refresh loop', () => {
  assert.equal(isRefreshExcluded('/auth/login'), true);
  assert.equal(isRefreshExcluded('/auth/register'), true);
  assert.equal(isRefreshExcluded('/auth/refresh'), true);
  assert.equal(isRefreshExcluded('/appointments'), false);
  assert.equal(isRefreshExcluded('/admin/audit-logs'), false);
  assert.equal(isRefreshExcluded(undefined), false);
});

test('concurrent 401s share a single refresh request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const manager = createRefreshManager({
    performRefresh: async () => {
      calls += 1;
      await gate;
      return { data: { token: 'access-token' } };
    },
    onLogout: () => {},
  });

  const pending = [manager.refresh(), manager.refresh(), manager.refresh()];
  assert.equal(manager.isRefreshing(), true);
  release();

  const results = await Promise.all(pending);
  assert.equal(calls, 1, 'only one refresh request may be in flight');
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(manager.isRefreshing(), false);
});

test('a failed refresh notifies the logout handler once and backs off', async () => {
  let calls = 0;
  let logouts = 0;
  let clock = 1000;

  const manager = createRefreshManager({
    performRefresh: async () => {
      calls += 1;
      throw new Error('refresh rejected');
    },
    onLogout: () => {
      logouts += 1;
    },
    now: () => clock,
    cooldownMs: 5000,
  });

  await assert.rejects(manager.refresh(), /refresh rejected/);
  assert.equal(logouts, 1);

  // Inside the cooldown no further request is made (no infinite retry loop).
  await assert.rejects(manager.refresh(), /not retrying yet/);
  await assert.rejects(manager.refresh(), /not retrying yet/);
  assert.equal(calls, 1);

  // Once the cooldown expires a fresh attempt is allowed, so recovered sessions work.
  clock += 5001;
  await assert.rejects(manager.refresh(), /refresh rejected/);
  assert.equal(calls, 2);
  assert.equal(logouts, 2);
});

test('a successful refresh clears the failure cooldown', async () => {
  let calls = 0;
  let clock = 1000;
  let failNext = true;

  const manager = createRefreshManager({
    performRefresh: async () => {
      calls += 1;
      if (failNext) throw new Error('transient failure');
      return { data: { token: 'access-token' } };
    },
    onLogout: () => {},
    now: () => clock,
    cooldownMs: 5000,
  });

  await assert.rejects(manager.refresh(), /transient failure/);
  failNext = false;
  clock += 5001;
  assert.deepEqual(await manager.refresh(), { data: { token: 'access-token' } });

  // No cooldown is left behind, so the next refresh goes straight out.
  assert.deepEqual(await manager.refresh(), { data: { token: 'access-token' } });
  assert.equal(calls, 3);
});

test('a synchronous throw in performRefresh still resolves the shared promise once', async () => {
  let calls = 0;
  const manager = createRefreshManager({
    performRefresh: () => {
      calls += 1;
      throw new Error('boom');
    },
    onLogout: () => {},
  });

  const results = await Promise.allSettled([manager.refresh(), manager.refresh()]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
});

test('readCookie reads the CSRF cookie and tolerates a missing document', () => {
  assert.equal(readCookie('csrf_token'), '');

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { cookie: 'csrf_token=abc%20123; other=1' };
  try {
    assert.equal(readCookie('csrf_token'), 'abc 123');
    assert.equal(readCookie('other'), '1');
    assert.equal(readCookie('missing'), '');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  }
});

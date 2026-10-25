import assert from 'node:assert/strict';
import test from 'node:test';
import { isSessionValid } from '../src/session.js';

test('rejects a session without an id', () => {
  assert.equal(isSessionValid({ id: '', userId: 'u', expiresAt: 2_000 }, 1_000), false);
});

test('accepts a session that has not expired', () => {
  assert.equal(isSessionValid({ id: 's1', userId: 'u', expiresAt: 2_000 }, 1_000), true);
});

test('rejects an expired session', () => {
  assert.equal(isSessionValid({ id: 's1', userId: 'u', expiresAt: 1_000 }, 2_000), false);
});

test('rejects a session at the exact expiry instant', () => {
  assert.equal(isSessionValid({ id: 's1', userId: 'u', expiresAt: 1_000 }, 1_000), false);
});

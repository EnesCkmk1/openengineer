import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuditLine } from '../src/audit.js';

test('builds an audit line for an active session', () => {
  const line = buildAuditLine({ id: 's1', userId: 'ada', expiresAt: 5_000 }, 1_000);
  assert.equal(line, 'user:ada valid');
});

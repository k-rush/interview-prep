import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGate, receiptKey } from './check-release.mjs';

const now = Date.parse('2026-11-25T12:00:00Z');
const request = { operation: 'promote', ring: 'production', commit: 'a'.repeat(40), digest: 'sha256:' + 'b'.repeat(64) };
const receipt = { ...request, ring: 'staging', deploymentId: 'candidate-1', profile: 'public-demo-v1', status: 'healthy', criticalChecksPassed: true,
  deployedAt: '2026-11-25T11:25:00Z', observedAt: '2026-11-25T11:55:00Z', completedChecks: 5 };

test('only adjacent, fresh evidence for the identical image admits production', () => {
  assert.equal(receiptKey(request), 'rings/staging/current.json');
  checkGate(request, receipt, now);
  for (const patch of [{ ring: 'production' }, { digest: 'sha256:' + 'c'.repeat(64) }, { commit: 'd'.repeat(40) },
    { criticalChecksPassed: false }, { completedChecks: 4 }, { observedAt: '2026-11-25T11:54:59Z' },
    { observedAt: '2026-11-25T13:00:00Z' }, { deployedAt: 'yesterday' }]) {
    assert.throws(() => checkGate(request, { ...receipt, ...patch }, now));
  }
  assert.throws(() => checkGate(request, receipt, now + 3 * 3600_000));
});

test('rollback needs known-good evidence in the destination, not just the prior ring', () => {
  const rollback = { ...request, operation: 'rollback' };
  assert.match(receiptKey(rollback), /^history\/production\//);
  assert.throws(() => checkGate(rollback, receipt, now));
  checkGate(rollback, { ...receipt, ring: 'production' }, now);
});

test('staging is the only entry ring; retired rings, tags and unexpected operations fail closed', () => {
  assert.equal(receiptKey({ ...request, ring: 'staging' }), null);
  for (const patch of [{ operation: 'skip' }, { ring: 'test' }, { ring: 'canary' }, { commit: 'main' }, { digest: 'latest' }]) {
    assert.throws(() => receiptKey({ ...request, ...patch }));
  }
});

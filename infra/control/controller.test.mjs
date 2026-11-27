import assert from 'node:assert/strict';
import test from 'node:test';
import { operate } from './controller.mjs';

const commit = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64), next = 'sha256:' + 'c'.repeat(64);
function fixture(ring = 'staging') {
  const blobs = new Map(), deployed = [], checks = ['health', 'ready', 'sample', 'assets', 'locked'];
  return { ring, purpose: 'deploy', blobs, deployed, current: {}, checks,
    async locked(action) { await action(this.current); },
    async record(value) { this.current = value; },
    async read(container, key) { return blobs.get(`${container}/${key}`); },
    async archive(key, receipt) { blobs.set(`${ring}/${key}`, receipt); },
    async deploy(image) { deployed.push(image); },
    async contain() { deployed.push('internal-only'); },
    async verify(value) { if (value.digest === this.bad) throw Error('Probe failed'); return checks; }
  };
}
const put = (io, image = digest, id = '100') => operate(io, ['promote', io.ring, commit, image, id]);
test('publish only after smoke, replay without deploying, refuse superseded/frozen runs and isolate observer', async () => {
  const io = fixture();
  await put(io);
  assert.equal(io.current.profile, 'public-demo-v1');
  assert.deepEqual(io.current.checks, io.checks);
  await put(io);
  await assert.rejects(put(io, next, '99'), /Superseded/);
  io.blobs.set('staging/freeze.json', {});
  await assert.rejects(put(io, next, '101'), /frozen/);
  io.purpose = 'monitor';
  await assert.rejects(put(io), /not permitted/);
  io.bad = digest;
  await assert.rejects(operate(io, ['monitor', 'staging', '-', '-', '102']), /Probe failed/);
  assert.equal(io.current.status, 'unhealthy');
  assert.deepEqual(io.deployed, [digest]);
});
test('production needs baked staging evidence; failed switch restores last healthy digest; rollback needs local history', async () => {
  const stage = fixture(), prod = fixture('production');
  await put(stage);
  await assert.rejects(put(prod), /receipt/);
  const evidence = { ...stage.current, deployedAt: new Date(Date.now() - 31 * 60_000).toISOString() };
  prod.blobs.set('staging/rings/staging/current.json', stage.current);
  await assert.rejects(put(prod), /observation/);
  prod.blobs.set('staging/rings/staging/current.json', evidence);
  await put(prod);
  prod.blobs.set('staging/rings/staging/current.json', { ...evidence, digest: next });
  prod.bad = next;
  await assert.rejects(put(prod, next, '101'), /Probe failed/);
  assert.deepEqual(prod.deployed, [digest, next, digest]);
  assert.equal(prod.current.digest, digest);
  await assert.rejects(operate(prod, ['rollback', 'production', commit, next, '102']), /receipt/);
  await operate(prod, ['rollback', 'production', commit, digest, '102']);
});
test('a failed first release closes ingress and cannot create evidence for promotion', async () => {
  const io = fixture();
  io.bad = digest;
  await assert.rejects(put(io), /Probe failed/);
  assert.equal(io.current.status, 'failed');
  assert.deepEqual(io.deployed, [digest, 'internal-only']);
  assert.equal(io.blobs.size, 0);
});

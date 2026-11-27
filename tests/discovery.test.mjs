import assert from 'node:assert/strict';
import test from 'node:test';
import { localHost } from './local-host.mjs';

async function json(response) {
  const r = await response;
  assert.equal(r.status, 200, r.ok ? '' : await r.text());
  return r.json();
}

test('daily search is a single owner setting; a one-time report never opts in or replaces an enabled role', async t => {
  const app = await localHost(t), owner = await app.open(), other = await app.open();
  const daily = (cookie, body) => app.request('account/daily-search', cookie, body ? 'PUT' : 'GET', body);
  const fresh = { enabled: false, role: '' };
  assert.equal((await daily(null)).status, 401);
  assert.deepEqual(await json(daily(owner)), fresh);
  assert.deepEqual(await json(daily(owner, { enabled: false })), fresh);
  for (const input of [{}, { enabled: true }, { enabled: true, role: '  ' },
    { enabled: true, role: 'Engineer', zone: '../UTC' }, { enabled: true, role: 'reader@example.org' }])
    assert.equal((await daily(owner, input)).status, 400);
  assert.equal((await app.request('discovery/run', owner, 'POST')).status, 400);
  const report = await json(app.request('discovery/run', owner, 'POST', { role: 'Operations analyst', zone: 'UTC' }));
  assert.equal(report.replay, false);
  assert.deepEqual(await json(daily(owner)), { enabled: false, role: 'Operations analyst' });
  const { digests: [first], webSearchConfigured } = await json(app.request('discovery', owner));
  assert.equal(webSearchConfigured, false);
  assert.equal(first.status, 'partial');
  assert.equal(first.webSearch.incomplete, true);
  assert.deepEqual(first.webSearch.links, []);
  assert.match(first.webSearch.status, /not configured/);
  assert.doesNotMatch(first.nextStep, /add a board|paste|draft pair/i);

  // Enabling after a report is a preference write, not another lookup or history entry.
  assert.deepEqual(await json(daily(owner, { enabled: true })), { enabled: true, role: 'Operations analyst' });
  await app.restart();
  assert.equal((await json(app.request('chats', owner))).length, 1);
  assert.deepEqual((await json(app.request('discovery', owner))).digests.map(d => d.id), [report.id]);
  const fixedRole = { enabled: true, role: 'Data analyst' };
  assert.deepEqual(await json(daily(owner, fixedRole)), fixedRole);
  await json(app.request('discovery/run', owner, 'POST', { role: 'Designer' }));
  assert.deepEqual(await json(daily(owner)), fixedRole);
  assert.deepEqual(await json(daily(owner, { enabled: false })), { enabled: false, role: 'Data analyst' });
  assert.deepEqual(await json(daily(other)), fresh);
  assert.deepEqual((await json(app.request(`discovery?digestId=${report.id}`, other))).digests, []);
});

test('obsolete inputs cannot configure, populate or draft from a new public report', async t => {
  const app = await localHost(t), owner = await app.open();
  const request = (path, method, body) => app.request(`discovery/${path}`, owner, method, body);
  for (const [path, method, body] of [
    ['settings', 'PUT', { role: 'Data analyst', zone: 'UTC', localTime: '00:00', enabled: true, autoDraft: true }],
    ['boards', 'POST', { provider: 'greenhouse', slug: 'example', permitPublicLookup: true }],
    ['listings', 'POST', { title: 'Data analyst', employer: 'Private paste', permitPrivateUse: true }],
    ['matches/00000000-0000-0000-0000-000000000012/draft', 'POST']
  ]) assert.ok([404, 405].includes((await request(path, method, body)).status), `${method} ${path}`);
  assert.equal((await request('run', 'POST')).status, 400);
  await json(request('run', 'POST', { role: 'Data analyst', autoDraft: true, enabled: true, requirePay: true }));
  const state = await json(app.request('discovery', owner));
  assert.deepEqual(state.digests[0].matches, []);
  for (const retired of ['settings', 'roster', 'follows', 'listings']) assert.equal(retired in state, false);
  assert.deepEqual(await json(app.request('account/daily-search', owner)), { enabled: false, role: 'Data analyst' });
});

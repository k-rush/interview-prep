import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { localHost } from './local-host.mjs';

async function ok(response, status = 200) {
  const r = await response;
  if (r.status !== status) assert.fail(`Expected ${status}, received ${r.status}: ${await r.text()}`);
  return r;
}
const json = async response => (await ok(response)).json();
const preferences = (overrides = {}) => ({ role: 'Platform engineer', zone: 'Pacific/Kiritimati',
  localTime: '00:00', enabled: false, autoDraft: false, remoteOnly: true, ...overrides });
const listing = (overrides = {}) => ({ title: 'Platform engineer', employer: 'Fictional Orchard',
  mode: 'remote', location: 'Remote', must: 'SQL, Terraform', preferred: 'Budgeting', permitPrivateUse: true, ...overrides });
async function evidence(app, owner, claim, allowDrafts, project = 'Private evidence label') {
  const { id } = await json(app.request('evidence', owner, 'POST', { project, statement: claim }));
  if (allowDrafts !== null) await ok(app.request(`evidence/${id}/confirm`, owner, 'POST', { claim, allowDrafts }), 204);
  return id;
}
const state = (app, owner) => json(app.request('discovery', owner));
const dayIn = (zone, date = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

test('private shortlist → verbatim reviewed pair; ownership, quota replay and evidence invalidation survive restart', async t => {
  const app = await localHost(t), a = await app.open(), b = await app.open();
  const req = (path, method, body) => app.request(`discovery${path}`, a, method, body);
  await ok(app.request('discovery'), 401);
  const claim = 'I used SQL to check the <pilot> & migration results.';
  const fact = await evidence(app, a, claim, true);
  await evidence(app, a, 'I managed a secret Terraform billing project.', false);
  await evidence(app, a, 'I claim a Budgeting qualification that was never confirmed.', null);
  await evidence(app, b, 'I used Terraform at a different organization.', true);
  await ok(req('/settings', 'PUT', preferences()), 204);
  await ok(req('/listings', 'POST', listing({ permitPrivateUse: false })), 400);
  const { id: local } = await json(req('/listings', 'POST', listing()));
  for (const employer of ['Willow', 'Alder', 'Pine']) await json(req('/listings', 'POST', listing({ employer, must: 'COBOL', preferred: '' })));
  await json(req('/listings', 'POST', listing({ employer: 'Never shortlist on-site', mode: 'onsite', must: 'SQL', preferred: '' })));
  await json(req('/listings', 'POST', listing({ title: 'Sales associate', employer: 'Unrelated title', must: 'SQL', preferred: '' })));
  const [one, two] = await Promise.all([json(req('/run', 'POST')), json(req('/run', 'POST'))]);
  assert.equal(one.id, two.id);
  assert.deepEqual([one.replay, two.replay].sort(), [false, true]);
  let mine = await state(app, a);
  assert.equal(mine.digests.length, 1);
  const d = mine.digests[0], m = d.matches[0];
  assert.equal(d.localDate, dayIn('Pacific/Kiritimati'));
  assert.equal(d.matches.length, 3);
  assert.equal(d.status, 'complete');
  assert.equal(m.listing.employer, 'Fictional Orchard');
  assert.equal(m.fit.earned, 2);
  assert.equal(m.fit.possible, 5);
  assert.ok(m.fit.gaps.some(s => s.startsWith('Terraform: not documented')));
  assert.ok(d.matches.every(x => !['Never shortlist on-site', 'Unrelated title'].includes(x.listing.employer)));
  assert.equal(m.packets.length, 0);
  const { id: pair } = await json(req(`/matches/${m.id}/draft`, 'POST'));
  assert.equal((await json(req(`/matches/${m.id}/draft`, 'POST'))).id, pair);
  const path = `/drafts/${pair}`;
  const preview = await json(req(path));
  assert.equal(preview.approved, false);
  assert.deepEqual(preview.evidence.map(x => [x.id, x.claim, x.resumeClaim, x.letterClaim]), [[fact, claim, 1, 1]]);
  assert.ok(preview.resume.includes(claim) && preview.letter.includes(claim));
  assert.doesNotMatch(preview.resume + preview.letter, /Terraform|Budgeting|Private evidence label|different organization/);
  await ok(req(path + '/approve', 'POST', { version: 'not-reviewed' }), 409);
  await ok(req(path + '/export'), 409);
  await ok(req(path + '/approve', 'POST', { version: preview.version }), 204);
  const exported = await (await ok(req(path + '/export'))).text();
  assert.match(exported, /RESUME[\s\S]*COVER LETTER/);
  assert.doesNotMatch(exported, /Private evidence label|resumeClaim|Terraform/);
  const docx = await ok(req(path + '/export?format=docx'));
  assert.equal(docx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const packageBytes = Buffer.from(await docx.arrayBuffer());
  assert.equal(packageBytes.readUInt32LE(0), 0x04034b50);
  assert.ok(packageBytes.includes(Buffer.from('word/document.xml')));
  const print = await (await ok(req(path + '/export?format=print'))).text();
  assert.match(print, /&lt;pilot&gt; &amp; migration/);
  assert.doesNotMatch(print, /<pilot>|Private evidence label/);
  await app.restart();
  assert.equal((await json(req('/run', 'POST'))).id, d.id);
  assert.equal((await json(req(path))).approved, true);
  const theirs = await state(app, b);
  assert.deepEqual([theirs.digests, theirs.listings, theirs.follows], [[], [], []]);
  for (const [url, method, body] of [
    [path], [path + '/export'], [path + '/approve', 'POST', { version: preview.version }],
    [`/matches/${m.id}/draft`, 'POST'], [`/matches/${m.id}/prep`], [`/matches/${m.id}/dismiss`, 'POST', { reason: 'not relevant' }],
    [`/listings/${local}`, 'PUT', listing()], [`/listings/${local}`, 'DELETE']
  ]) await ok(app.request('discovery' + url, b, method, body), 404);

  await ok(app.request(`evidence/${fact}/confirm`, a, 'POST', { claim, allowDrafts: false }), 204);
  await ok(req(path), 409); await ok(req(path + '/export'), 409);
  await ok(app.request(`evidence/${fact}/confirm`, a, 'POST', { claim, allowDrafts: true }), 204);
  await ok(req(path), 409); // Regrant is a new version, never implicit reapproval of the old export.
  const second = await json(req(`/matches/${m.id}/draft`, 'POST'));
  assert.notEqual(second.id, pair);
  const corrected = 'I used SQL to investigate a different test run.';
  await ok(app.request(`evidence/${fact}/confirm`, a, 'POST', { claim: corrected, allowDrafts: true }), 204);
  await ok(req(`/drafts/${second.id}`), 409);
  const third = await json(req(`/matches/${m.id}/draft`, 'POST'));
  const updated = await json(req(`/drafts/${third.id}`));
  assert.ok(updated.resume.includes(corrected) && !updated.resume.includes(claim));
  await ok(app.request(`evidence/${fact}`, a, 'DELETE'), 204);
  await ok(req(`/drafts/${third.id}/approve`, 'POST', { version: updated.version }), 409);
  mine = await state(app, a);
  assert.ok(mine.digests[0].matches[0].packets.every(p => !p.current));
  assert.ok(!JSON.stringify(mine).includes(corrected));

  await ok(req(`/matches/${m.id}/dismiss`, 'POST', { reason: 'stale listing' }), 204);
  await json(req(`/listings/${local}`, 'PUT', listing({ preferred: 'Python' })));
  await ok(req('/settings', 'PUT', preferences({ zone: 'Pacific/Pago_Pago' })), 204);
  await json(req('/run', 'POST'));
  mine = await state(app, a);
  assert.equal(mine.digests.length, 2);
  assert.ok(!mine.digests[0].matches.some(x => x.listing?.employer === 'Fictional Orchard'));
  assert.equal(mine.digests[1].matches[0].status, 'dismissed');
  await ok(req(`/listings/${local}`, 'DELETE'), 204);
  await ok(app.request('workspace', a, 'DELETE'), 204);
  await ok(req(path), 401);
  assert.equal((await state(app, b)).digests.length, 0);
});

test('scheduled restart processes the latest local day once; replayed employer feeds share only scoped public metadata', async t => {
  const directory = join(process.cwd(), `.discovery-fixture-${randomUUID()}`);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gh = [{ id: 123, title: 'Data analyst', location: { name: 'Remote' }, content: 'SQL and Python.',
    absolute_url: 'https://untrusted.invalid/never-follow', private_looking_unknown_field: 'Never publish raw provider payload' }];
  await writeFile(join(directory, 'greenhouse.orchard.json'), JSON.stringify({ jobs: gh }));
  await writeFile(join(directory, 'lever.alder.json'), JSON.stringify([{ id: 'a5a46137-3bcf-4a51-9177-8c803507afaa', text: 'Data analyst',
    workplaceType: 'remote', categories: { location: 'Remote' }, descriptionPlain: 'SQL.', salaryRange: { min: 80, max: 100, currency: 'USD', interval: 'hour' } }]));
  // The missing third fixture is a deterministic source outage. Replay mode cannot issue HTTP, even on a miss.
  const options = { INTERVIEW_PREP_SCOUT_REPLAY_DIR: directory,
    INTERVIEW_PREP_SCOUT_BOARDS: 'greenhouse:orchard,lever:alder,lever:unavailable' };
  const app = await localHost(t, undefined, options), a = await app.open(), b = await app.open();
  const req = (path, method, body) => app.request('discovery' + path, a, method, body);
  const follow = (cookie, provider, slug, permitPublicLookup = true) =>
    app.request('discovery/boards', cookie, 'POST', { provider, slug, permitPublicLookup });
  assert.equal((await state(app, a)).replay, true);
  await ok(follow(a, 'greenhouse', 'orchard', false), 400);
  await ok(follow(a, 'greenhouse', 'https://anything.invalid'), 400);
  await ok(follow(a, 'greenhouse', '../orchard'), 400);
  await ok(follow(a, 'greenhouse', 'unapproved'), 400);
  for (const k of [['greenhouse', 'orchard'], ['lever', 'alder'], ['lever', 'unavailable']]) await ok(follow(a, ...k), 204);
  await evidence(app, a, 'I wrote SQL queries for my private atlas.', true);
  await json(req('/listings', 'POST', listing({ title: 'Data analyst', employer: 'PRIVATE-pasted-employer', must: 'SQL', preferred: '' })));
  await ok(req('/settings', 'PUT', preferences({ role: 'Data analyst', enabled: true, autoDraft: true })), 204);
  await app.restart();
  let s = await state(app, a);
  for (let i = 0; !s.digests.length && i < 60; i++) { await sleep(100); s = await state(app, a); }
  assert.equal(s.digests.length, 1);
  const d = s.digests[0];
  assert.equal(d.trigger, 'scheduled');
  assert.equal(d.status, 'partial');
  assert.equal(d.localDate, dayIn('Pacific/Kiritimati'));
  assert.ok(new Date(s.settings.nextDueUtc) > new Date());
  assert.ok(d.coverage.some(c => c.includes('lever:unavailable') && c.includes('unavailable:')));
  assert.equal(d.matches.length, 3);
  assert.equal(d.matches.flatMap(m => m.packets).length, 1);
  assert.ok(d.matches.every(m => m.listing.url === null));
  assert.doesNotMatch(JSON.stringify(s), /untrusted\.invalid|Never publish raw provider payload/);
  assert.match(d.matches.find(m => m.listing.employer === 'alder').listing.pay, /80–100 USD hour/);
  const lookup = (owner, url) => app.request('targets/lookup', owner, 'POST', {jobUrl:url});
  const url='https://job-boards.greenhouse.io/orchard/jobs/123?tracking=never-forward';
  const linked=await json(lookup(a,url));
  assert.equal(linked.role,'Data analyst');assert.match(linked.description,/SQL/);assert.match(linked.source,/fixture/);
  assert.doesNotMatch(JSON.stringify(linked),/tracking|Never publish|untrusted.invalid/);
  await ok(lookup(b,url),400);
  await ok(lookup(a,'https://example.invalid/job'),400);
  assert.equal((await json(req('/run', 'POST'))).id, d.id);
  await app.restart();
  assert.equal((await state(app, a)).digests[0].matches.flatMap(m => m.packets).length, 1);

  await rm(join(directory, 'greenhouse.orchard.json'));
  await ok(follow(b, 'greenhouse', 'orchard'), 204);
  await ok(app.request('discovery/settings', b, 'PUT', preferences({ role: 'Data analyst' })), 204);
  await json(app.request('discovery/run', b, 'POST'));
  const theirs = await state(app, b), match = theirs.digests[0].matches[0];
  assert.equal(theirs.digests[0].status, 'complete'); // Uses permitted cached snapshot despite the source fixture now being absent.
  assert.equal(match.listing.employer, 'orchard');
  assert.equal(match.fit.earned, 0);
  assert.equal(theirs.digests[0].matches.length, 1);
  assert.doesNotMatch(JSON.stringify(theirs), /PRIVATE-pasted-employer|private atlas/);
  assert.ok(theirs.digests[0].coverage.every(c => !c.includes('lever:alder')));
  await ok(req('/boards/greenhouse/orchard', 'DELETE'), 204);
  assert.equal((await state(app, b)).digests[0].matches[0].status, 'current');
  assert.equal((await state(app, a)).digests[0].matches.find(m => m.id === d.matches.find(x => x.listing.employer === 'orchard').id).listing, null);
  await ok(req('/pause', 'POST'), 204);
  await app.restart();
  s = await state(app, a);
  assert.equal(s.settings.enabled, false);
  assert.equal(s.settings.nextDueUtc, null);
  assert.equal(s.digests.length, 1);
});

test('IANA scheduling skips spring gaps, chooses the first fall occurrence and rejects unresolvable schedules', async t => {
  const app = await localHost(t), owner = await app.open();
  for (const [zone, localTime, date, expected] of [
    ['America/New_York', '02:30', '2026-03-08', '2026-03-08T07:00:00.000Z'],
    ['America/New_York', '01:30', '2026-11-01', '2026-11-01T05:30:00.000Z'],
    ['Asia/Kolkata', '03:15', '2026-11-01', '2026-10-31T21:45:00.000Z']
  ]) {
    const r = await json(app.request(`discovery/schedule-preview?${new URLSearchParams({ zone, localTime, date })}`, owner));
    assert.equal(new Date(r.dueUtc).toISOString(), expected);
  }
  for (const opts of [{ zone: 'Pacific Standard Time' }, { zone: '../UTC' }, { localTime: '24:61' }, { autoDraft: true }])
    await ok(app.request('discovery/settings', owner, 'PUT', preferences(opts)), 400);
  assert.equal((await state(app, owner)).settings.enabled, false);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { localHost } from './local-host.mjs';

const roles = ['Data analyst · Orchard', 'Data analyst · SQL', 'Data analyst · Forecasting',
  'Data analyst · Accessibility', 'Data analyst · Inventory'];
const cite = (title, id) => ({ type: 'url_citation', title, url: `https://careers.example.com/jobs/${id}` });
const response = { status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Data analyst jobs' } },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Never publish the generated vacancy or salary claim.',
    annotations: [cite(roles[0], 0), cite('Duplicate', 0), { type: 'url_citation', title: 'Unsafe', url: 'http://127.0.0.1/private' },
      ...roles.slice(1).map((r, i) => cite(r, i + 1))] }] }
] };
async function fixture(t) {
  const directory = join(process.cwd(), `.scout-search-fixture-${randomUUID()}`);
  await mkdir(directory);
  const file = join(directory, 'response.json');
  await writeFile(file, JSON.stringify(response));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { file, config: { INTERVIEW_PREP_SCOUT_SEARCH_REPLAY_FILE: file } };
}
async function json(request) {
  const res = await request;
  assert.ok(res.ok, `${res.status}: ${res.ok ? '' : await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}
const chat = async (app, owner, kind) => (await json(app.request('chats', owner, 'POST', { kind, requestId: randomUUID() }))).id;
const say = (app, owner, id, revision, text) => json(app.request(`chats/${id}/turns`, owner, 'POST',
  { text, revision, requestId: randomUUID(), zone: 'UTC' }));
const run = (app, owner) => json(app.request('discovery/run', owner, 'POST', { role: 'Data analyst', zone: 'UTC' }));
const read = async (app, owner) => (await json(app.request('discovery', owner))).digests[0];

test('public citations are compared locally with each owner’s current messages, editable memory and job history', async t => {
  const { config, file } = await fixture(t);
  const app = await localHost(t, undefined, config), a = await app.open(), b = await app.open();
  const id = await chat(app, a, 'builder');
  await say(app, a, id, 0, 'Could SQL be the topic for PRIVATE-MESSAGE-EXAMPLE?');
  await say(app, a, id, 1, 'Remember: Forecasting interests me. PRIVATE-NOTE-EXAMPLE');
  await json(app.request('experience/nodes', a, 'POST', { kind: 'role', label: 'Accessibility auditor', employer: 'PRIVATE-HISTORY-EXAMPLE' }));
  const otherChat = await chat(app, b, 'builder');
  await say(app, b, otherChat, 0, 'Remember: Inventory interests me. OTHER-OWNER-EXAMPLE');

  const [one, two] = await Promise.all([run(app, a), run(app, a)]);
  assert.equal(one.id, two.id);
  assert.deepEqual([one.replay, two.replay].sort(), [false, true]);
  const state = await json(app.request('discovery', a)), d = state.digests[0];
  assert.equal(state.webSearchConfigured, true);
  assert.equal(d.status, 'complete');
  assert.deepEqual(d.matches, []);
  assert.match(d.webSearch.status, /fixture.*not a live/);
  const links = d.webSearch.links;
  assert.deepEqual(links.map(l => l.title), [roles[1], roles[2], roles[3], roles[0], roles[4]]);
  assert.deepEqual(links.map(l => l.rank), [1, 2, 3, 4, 5]);
  assert.match(links[0].reason, /your messages/);
  assert.match(links[1].reason, /agent notes/);
  assert.match(links[2].reason, /job history/);
  assert.match(links[3].reason, /No additional workspace wording/);
  assert.match(d.nextStep, /check responsibilities, availability/i);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE-|OTHER-OWNER|generated vacancy|salary claim|127\.0\.0\.1|Duplicate/);

  await run(app, b);
  assert.equal((await read(app, b)).webSearch.links[0].title, roles[4]);
  assert.deepEqual((await json(app.request(`discovery?digestId=${d.id}`, b))).digests, []);
  const [note] = await json(app.request('chats/memory', a));
  await json(app.request(`chats/memory/${note.id}`, a, 'PUT', { text: 'Inventory now interests me.' }));
  const edited = (await read(app, a)).webSearch.links;
  assert.match(edited.find(l => l.title === roles[4]).reason, /agent notes/);
  assert.doesNotMatch(edited.find(l => l.title === roles[2]).reason, /agent notes|your messages/);
  await json(app.request(`chats/memory/${note.id}`, a, 'DELETE'));
  await rm(file);
  await app.restart();
  assert.equal((await run(app, a)).id, d.id);
  const saved = (await json(app.request(`discovery?digestId=${d.id}`, a))).digests[0];
  assert.equal(saved.webSearch.links.length, 5);
  assert.ok(saved.webSearch.links.every(l => !l.reason.includes('agent notes')));
});

test('missing or malformed replay is unavailable without a network fallback; an empty completed search is distinct', async t => {
  const { config, file } = await fixture(t);
  const app = await localHost(t, undefined, config);
  await rm(file);
  for (const contents of [null, '{bad', JSON.stringify({ status: 'incomplete' })]) {
    if (contents !== null) await writeFile(file, contents);
    const owner = await app.open();
    await run(app, owner);
    const failed = await read(app, owner);
    assert.equal(failed.status, 'partial');
    assert.equal(failed.webSearch.incomplete, true);
    assert.deepEqual(failed.webSearch.links, []);
    assert.match(failed.coverage.join(' '), /unavailable/);
  }
  await writeFile(file, JSON.stringify({ ...response, output: [response.output[0]] }));
  const owner = await app.open();
  await run(app, owner);
  const empty = await read(app, owner);
  assert.deepEqual(empty.webSearch.links, []);
  assert.equal(empty.status, 'complete');
  assert.match(empty.nextStep, /no usable cited links.*does not mean there are no jobs/i);
});

test('chat and scheduled reports compare public results; accepting a report’s daily offer does not search again', async t => {
  const { config } = await fixture(t);
  const app = await localHost(t, undefined, config), a = await app.open(), b = await app.open();
  const id = await chat(app, a, 'scout');
  assert.match((await json(app.request(`chats/${id}`, a))).messages[0].text, /public job title|public role/i);
  await say(app, a, id, 0, 'Data analyst');
  const report = await json(app.request(`chats/${id}`, a));
  assert.match(report.messages.at(-1).text, /1\. Data analyst · Orchard[\s\S]*2\. Data analyst · SQL/);
  assert.match(report.messages.at(-1).text, /daily/i);
  assert.equal((await json(app.request('account/daily-search', a))).enabled, false);
  await say(app, a, id, 1, 'yes');
  assert.deepEqual(await json(app.request('account/daily-search', a)), { enabled: true, role: 'Data analyst' });
  assert.deepEqual((await json(app.request('discovery', a))).digests.map(d => d.id), [report.session.digestId]);

  // Choose a zone safely past the fixed morning delivery, avoiding a clock dependency.
  const zone = ['UTC', 'Asia/Tokyo', 'Pacific/Honolulu', 'Asia/Kolkata'].find(z => {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    return h >= 10 && h <= 22;
  });
  assert.ok(zone);
  await json(app.request('account/daily-search', b, 'PUT', { enabled: true, role: 'Data analyst', zone }));
  await app.restart();
  let scheduled;
  for (let attempt = 0; !scheduled && attempt < 60; attempt++) {
    scheduled = await read(app, b);
    if (!scheduled) await sleep(100);
  }
  assert.equal(scheduled?.trigger, 'scheduled');
  assert.equal(scheduled.zone, zone);
  assert.deepEqual(scheduled.webSearch.links.map(l => l.title), roles);
  assert.deepEqual(scheduled.matches, []);
  const [published] = await json(app.request('chats', b));
  const message = (await json(app.request(`chats/${published.id}`, b))).messages[0].text;
  assert.match(message, /unverified public citation/);
  assert.match(message, /1\. Data analyst · Orchard[\s\S]*2\. Data analyst · SQL/);
  assert.equal((await json(app.request('discovery', a))).digests.length, 1);
});

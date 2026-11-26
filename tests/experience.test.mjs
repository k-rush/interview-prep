import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { localHost } from './local-host.mjs';

async function ok(response, status = 200) {
  const r = await response;
  assert.equal(r.status, status, r.status === status ? undefined : await r.text());
  if (status === 200) return r.json();
}

test('selected evidence retains attribution and workspace ownership; export follows current permission and forgetting', async t => {
  const app = await localHost(t), a = await app.open(), b = await app.open();
  const get = (path, who = a) => ok(app.request(`experience${path}`, who));
  const post = (path, body, who = a) => app.request(`experience${path}`, who, 'POST', body);
  const { id: role } = await ok(post('/nodes', { kind: 'role', label: 'Fixture role', employer: 'Sample org', dates: 'Spring 2025' }));
  const { id: project } = await ok(post('/nodes', { kind: 'project', label: 'Rollout guide', parentRoleId: role }));
  await ok(post('/nodes', { kind: 'project', label: 'Other', parentRoleId: role }, b), 404);
  const bookmark = { category: 'project-bookmark', title: 'Unverified project page', url: 'https://project.invalid/demo',
    nodeId: project, excerpts: [], reviewed: true };
  await ok(post('/sources', { ...bookmark, reviewed: false }), 400);
  await ok(post('/sources', { ...bookmark, url: 'file:///example' }), 400);
  await ok(post('/sources', bookmark, b), 404);
  await ok(post('/sources', bookmark));
  assert.equal((await app.state(a)).facts.length, 0, 'saving a link must not assert authorship');
  const review = { category: 'performance-review', title: 'Pilot assessment', nodeId: project, reviewed: true,
    excerpts: [{ text: 'The team piloted a checklist.', location: 'Page 2' }, { text: 'The team scheduled a rehearsal.', location: 'Page 3' }] };
  const { id: source } = await ok(post('/sources', review));
  const [fact, other] = (await app.state(a)).facts.sort((x, y) => x.source.localeCompare(y.source));
  assert.deepEqual([fact.confirmed, fact.allowDrafts, fact.allowLive], [false, false, false]);
  assert.equal(fact.claim, review.excerpts[0].text);
  assert.match(fact.source, /third-party assessment.*Page 2/);
  assert.equal((await get('/resume')).text, '');
  await ok(app.request(`evidence/${fact.id}/confirm`, a, 'POST', { claim: 'I documented my own review steps.', allowDrafts: true }), 204);
  await ok(app.request(`evidence/${other.id}/confirm`, a, 'POST', { claim: other.claim, allowLive: true }), 204);
  await app.restart();
  const mine = await get(''), theirs = await get('', b);
  assert.equal(mine.nodes.find(n => n.id === project).parentRoleId, role);
  assert.equal(mine.sources.find(s => s.id === source).nodeId, project);
  assert.equal(mine.citations.filter(c => c.sourceId === source).length, 2);
  assert.deepEqual([theirs.nodes, theirs.sources, theirs.citations], [[], [], []]);
  const resume = await get('/resume');
  assert.equal(resume.factCount, 1);
  assert.match(resume.text, /my own review steps/);
  assert.doesNotMatch(resume.text, /assessment|team|Page|Rollout/);
  await ok(app.request(`evidence/${fact.id}/confirm`, a, 'POST', { claim: 'Corrected.', allowDrafts: false }), 204);
  assert.equal((await get('/resume')).text, '');
  await ok(app.request(`experience/sources/${source}`, b, 'DELETE'), 404);
  await ok(app.request(`experience/sources/${source}`, a, 'DELETE'), 204);
  assert.deepEqual((await app.state(a)).facts, []);
  await ok(app.request(`experience/nodes/${role}`, a, 'DELETE'), 204);
  assert.deepEqual((await get('')).sources, []);
  assert.deepEqual((await get('')).nodes, []);
});

test('a builder resumes the exact probe, deduplicates turns, preserves uncertainty and never self-confirms', async t => {
  const app = await localHost(t), a = await app.open(), b = await app.open();
  const { id } = await ok(app.request('experience/builders', a, 'POST', { goal: 'Platform engineer', minutes: 5 }));
  const route = `experience/builders/${id}`;
  const read = () => ok(app.request(route, a));
  const state = (revision, state) => app.request(`${route}/state`, a, 'POST', { revision, state });
  const send = (revision, text, mode = 'answer', clientTurnId = randomUUID(), who = a) =>
    app.request(`${route}/turns`, who, 'POST', { revision, clientTurnId, text, mode });
  const first = await read();
  assert.equal(first.turns.length, 1);
  await ok(send(0, 'Other', 'answer', randomUUID(), b), 404);
  const key = randomUUID();
  await ok(send(0, 'Release engineer', 'answer', key), 204);
  await ok(send(0, 'Release engineer', 'answer', key), 204);
  await ok(send(0, 'Another role', 'answer', key), 409);
  await ok(send(0, 'Stale'), 409);
  await ok(send(1, 'Rollout guide'), 204);
  await ok(send(2, 'We piloted a checklist as a team.'), 204);
  const before = await read();
  assert.match(before.turns.at(-1).text, /Which part was yours/);
  await ok(state(3, 'paused'), 204);
  await ok(send(4, 'Not while paused.'), 409);
  await app.restart();
  const resumed = await read();
  assert.equal(resumed.session.state, 'paused');
  assert.deepEqual(resumed.turns, before.turns);
  await ok(state(4, 'active'), 204);
  await ok(send(5, 'I wrote the operator checklist.'), 204);
  await ok(send(6, null, 'unknown'), 204);
  const closed = await read();
  assert.equal(closed.session.state, 'closed');
  assert.equal(closed.turns.filter(t => t.mode === 'unknown').length, 1);
  const facts = (await app.state(a)).facts;
  assert.deepEqual(facts.map(f => f.claim).sort(), ['I wrote the operator checklist.', 'We piloted a checklist as a team.']);
  assert.ok(facts.every(f => !f.confirmed && !f.allowDrafts && !f.allowLive && /Builder turn \d+/.test(f.source)));
  const lib = await ok(app.request('experience', a));
  assert.equal(lib.nodes.find(n => n.kind === 'project').parentRoleId, lib.nodes.find(n => n.kind === 'role').id);
  assert.ok(lib.citations.every(c => closed.turns.some(t => t.id === c.turnId && t.speaker === 'candidate')));
  await ok(app.request(route, b, 'DELETE'), 404);
  await ok(app.request(route, a, 'DELETE'), 204);
  assert.deepEqual((await app.state(a)).facts, []);
  const after = await ok(app.request('experience', a));
  assert.deepEqual([after.builders, after.citations], [[], []]);
});

test('opt-in extraction and probes use bounded local packets and fall back on invented model text', async t => {
  const packets = [];
  const model = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const packet = JSON.parse(JSON.parse(body).messages[1].content);
    packets.push(packet);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ labels:[{kind:'role',label:'Invented position'}], quotes: [packet.category === 'Resume' ? 'I wrote the notes.' : 'I led a launch.'],
      suggestion: { question: 37, quote: 'Revenue doubled.' } }) } }] }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(() => new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }));
  const app = await localHost(t, model.address().port), a = await app.open();
  const save = useModel => app.request('experience/sources', a, 'POST', { category: 'referral', title: 'Private title, not model data',
    reviewed: true, useModel, excerpts: [{ location: 'Paragraph 2', text: 'The team reviewed the plan.' }] });
  await ok(save(false)); assert.equal(packets.length, 0);
  await ok(save(true)); assert.equal(packets.length, 1);
  assert.deepEqual(Object.keys(packets[0]).sort(), ['category', 'excerpts']);
  assert.ok((await app.state(a)).facts.every(f => f.claim === 'The team reviewed the plan.' && !f.confirmed));
  const { id } = await ok(app.request('experience/builders', a, 'POST', { goal: 'Design lead', useModel: true, minutes: 5 }));
  const route = `experience/builders/${id}`;
  for (const [revision, text] of ['Designer', 'Planning project', 'The team prototyped an interface.'].entries())
    await ok(app.request(`${route}/turns`, a, 'POST', { revision, text, mode: 'answer', clientTurnId: randomUUID() }), 204);
  assert.equal(packets.length, 2);
  assert.deepEqual(Object.keys(packets[1]).sort(), ['Goal', 'answer', 'options', 'stage']);
  assert.match((await ok(app.request(route, a))).turns.at(-1).text, /Which part was yours/);
  assert.ok((await app.state(a)).facts.every(f => !f.claim.includes('Revenue')));
  await ok(app.request('experience/sources', a, 'POST', { category: 'resume', title: 'Synthetic resume',
    reviewed: true, useModel: true, excerpts: [{ location: 'Page 1', text: 'I wrote the notes. We discussed them.' }] }));
  assert.ok((await app.state(a)).facts.some(f => f.claim === 'I wrote the notes.' && f.source.includes('We discussed them.') && !f.confirmed));
  await ok(app.request('experience/sources',a,'POST',{category:'project-write-up',title:'Project notes',reviewed:true,useModel:true,
    excerpts:[{location:'Header',text:'Situation: Pilot review. The team checked its design.'}]}));
  const library=await ok(app.request('experience',a));
  assert.ok(library.nodes.some(n=>n.kind==='situation' && n.label==='Pilot review'));
  assert.ok(!library.nodes.some(n=>n.label==='Invented position'));
});

test('merging conflicting evidence is explicit, rejects a stale snapshot and resets all permissions', async t => {
  const app = await localHost(t), a = await app.open(), b = await app.open();
  const source = async (category, title, text) => ok(app.request('experience/sources', a, 'POST',
    { category, title, reviewed: true, excerpts: [{ location: 'Selected paragraph', text }] }));
  const leftSource = await source('referral', 'Review', 'Our team prepared the guide.');
  await source('resume', 'Own notes', 'I edited the guide.');
  const original = (await app.state(a)).facts, left = original.find(f => f.origin.includes('Referral')), right = original.find(f => f.id !== left.id);
  const merge = (snapshot, cookie = a) => app.request('experience/merge', cookie, 'POST', { left: snapshot, right, claim: 'I edited the team guide.' });
  await ok(app.request(`evidence/${left.id}/confirm`, a, 'POST', { claim: left.claim, allowLive: true, allowDrafts: true }), 204);
  await ok(merge(left), 409);
  const latest = (await app.state(a)).facts.find(f => f.id === left.id);
  await ok(merge(latest, b), 404);
  const merged = await ok(merge(latest));
  const [fact] = (await app.state(a)).facts;
  assert.equal(fact.id, merged.id);
  assert.deepEqual([fact.confirmed, fact.allowDrafts, fact.allowLive], [false, false, false]);
  assert.match(fact.source, /third-party recommendation/);
  assert.match(fact.source, /I edited the guide/);
  const lib = await ok(app.request('experience', a));
  assert.deepEqual(lib.citations.map(c => c.factId), [merged.id, merged.id]);
  assert.equal((await ok(app.request('experience/resume', a))).factCount, 0);
  await ok(app.request(`experience/sources/${leftSource.id}`, a, 'DELETE'), 204);
  assert.deepEqual((await app.state(a)).facts, []);
  await ok(app.request('workspace', a, 'DELETE'), 204);
  await ok(app.request('experience', a), 401);
});

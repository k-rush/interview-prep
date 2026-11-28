import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { compare } from './compare.mjs';
import { createGateway, modelAdapter } from './gateway.mjs';
import { caseRows, catalog, hostEnvironment, root, runCases, select, summarize } from './harness.mjs';
import { options } from './run.mjs';

const prompts = { 'test.ask': 'First reviewed instruction.', 'test.probe': 'Second reviewed instruction.' };
const packet = { answer: 'SYNTHETIC_PACKET_CANARY' };
const conversation = (id, run, extra) => ({ id, run, ...extra });
const suite = (...cs) => [[{ id: 'scenario', title: 'Synthetic journey', conversations: cs }]];
const noop = async () => {};
const requestBody = (system, model = 'replay') => ({ model, temperature: 0, stream: false, max_tokens: 80,
  response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(packet) }] });
async function post(gateway, body, extras = {}) {
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', ...extras },
    body: JSON.stringify(body), redirect: 'error'
  });
  return { status: res.status, data: await res.json() };
}
async function listener(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); return closed; });
  return server.address().port;
}
async function gatewayFor(t, adapter) {
  const gateway = await createGateway(prompts, adapter ?? await modelAdapter('replay', {}));
  t.after(() => gateway.close());
  return gateway;
}
const codes = scope => scope.failures.map(f => f.code);

test('rejects duplicate or malformed suites, selectors and CLI flags before running', () => {
  const a = conversation('answer', noop), b = conversation('retry', noop, { lanes: ['replay'] });
  const family = suite(a, b), cases = catalog(family);
  assert.deepEqual(select(cases, ['scenario/retry']).map(c => c.id), ['scenario/retry']);
  assert.equal(select(cases, ['scenario']).length, 2);
  for (const bad of [[], [[]], suite(a), suite(a, a), suite({ ...a, id: 'Invalid!' }, b),
    suite(a, { ...b, run: null }), suite(a, { ...b, lanes: [] }), [...family, ...family]])
    assert.throws(() => catalog(bad));
  assert.throws(() => select(cases, ['missing']), /unknown-case/);
  assert.throws(() => select(cases, ['scenario', 'scenario/retry']), /overlapping/);
  for (const args of [[], ['--lane', 'other'], ['--lane', 'live', '--lane', 'replay'], ['--report', '--case'], ['--unknown']])
    assert.throws(() => options(args));
});

test('replay checks ordered system texts and structured packets; a null fixture is an intentional outage', async t => {
  const g = await gatewayFor(t), s = g.begin();
  s.expect('test.ask', p => ({ echo: p.answer }), p => assert.deepEqual(p, packet));
  s.expect('test.probe', null);
  const first = await post(g, requestBody(prompts['test.ask']));
  assert.deepEqual(JSON.parse(first.data.choices[0].message.content), { echo: packet.answer });
  assert.equal((await post(g, requestBody(prompts['test.probe']))).status, 503);
  await s.end();
  assert.deepEqual(s.calls.map(c => [c.prompt, c.outcome]), [['test.ask', 'replayed'], ['test.probe', 'fixture-unavailable']]);
  assert.deepEqual(s.failures, []);
  assert.doesNotMatch(JSON.stringify(s), /SYNTHETIC_PACKET_CANARY|reviewed instruction/);
});

test('an HTTP fallback cannot hide wrong, missing, surplus or overlapping model calls', async t => {
  await assert.rejects(createGateway({ a: 'same', b: 'same' }, await modelAdapter('replay')), /ambiguous-system-prompt/);
  const g = await gatewayFor(t), s = g.begin();
  s.expect('test.ask', {}); s.expect('test.probe', {});
  assert.equal((await post(g, requestBody(prompts['test.probe']))).status, 502);
  const malformed = requestBody(prompts['test.probe']); malformed.messages[1].content = '[]';
  assert.equal((await post(g, malformed)).status, 502);
  await post(g, requestBody(prompts['test.ask']));
  s.expect('test.ask', {}); await s.end();
  assert.deepEqual(codes(s), ['wrong-system-prompt', 'invalid-user-packet', 'unexpected-model-call', 'missing-model-call']);
  const q = g.begin(); let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  q.expect('test.ask', {}, async () => { entered(); await gate; });
  const inFlight = post(g, requestBody(prompts['test.ask'])); await ready;
  try { assert.equal((await post(g, requestBody(prompts['test.ask']))).status, 409); }
  finally { finish(); await inFlight; await q.end(); }
  assert.deepEqual(codes(q), ['overlapping-model-calls']);
  assert.equal((await post(g, requestBody('unknown'))).status, 409);
  assert.deepEqual(codes(g), ['out-of-context-model-call']);
});

test('only live reports record an optional strict SHA-256 operator attestation', async () => {
  const env = { INTERVIEW_PREP_MODEL_ID: 'test', INTERVIEW_PREP_MODEL_PORT: '4321' }, revision = 'ab'.repeat(32);
  const withRevision = value => ({ ...env, INTERVIEW_PREP_EVAL_MODEL_REVISION: value });
  assert.ok(!Object.hasOwn((await modelAdapter('live', env)).model, 'revision'));
  assert.equal((await modelAdapter('live', withRevision(revision))).model.revision, revision);
  for (const bad of ['', revision.toUpperCase(), revision.slice(1), revision + '0', revision + '\n', 'private-value', null])
    await assert.rejects(modelAdapter('live', withRevision(bad)), { message: 'invalid-model-revision' });
  assert.ok(!Object.hasOwn((await modelAdapter('replay', withRevision('unused'))).model, 'revision'));
});

test('live forwards only inspected calls to the fixed local route; redirects, unusable completions and key leaks fail closed', async t => {
  const dir = join(root, 'evals', 'obj');
  await mkdir(dir, { recursive: true });
  const keyFile = join(dir, `${randomUUID()}.key`), key = randomUUID().replaceAll('-', '').repeat(2);
  await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 }); t.after(() => rm(keyFile));
  const received = []; let trapHits = 0, behavior = 'valid';
  const trap = await listener(t, (_req, res) => { trapHits++; res.end(); });
  const port = await listener(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    if (behavior === 'redirect') { res.writeHead(307, { location: `http://127.0.0.1:${trap}/never` }); res.end(); return; }
    const content = behavior === 'bad' ? 'not JSON' : JSON.stringify({ reply: behavior === 'echo-key' ? key : 'Provider answer' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }], model: 'loopback-test' }));
  });
  const env = { INTERVIEW_PREP_MODEL_PORT: String(port), INTERVIEW_PREP_MODEL_ID: 'loopback-test', INTERVIEW_PREP_MODEL_KEY_FILE: keyFile,
    INTERVIEW_PREP_EVAL_MODEL_REVISION: 'ab'.repeat(32) };
  await assert.rejects(modelAdapter('live', { ...env, INTERVIEW_PREP_EVAL_MODEL_REVISION: key }), { message: 'invalid-model-revision' });
  for (const value of ['https://example.invalid', '127.0.0.1:8080', '0', '65536', '1#@example.invalid'])
    await assert.rejects(modelAdapter('live', { ...env, INTERVIEW_PREP_MODEL_PORT: value }), /local-model-port/);
  await assert.rejects(modelAdapter('live', {}), /local-model-port/);
  await assert.rejects(modelAdapter('live', { ...env, INTERVIEW_PREP_MODEL_ID: undefined }), /model-id/);
  const adapter = await modelAdapter('live', env), g = await gatewayFor(t, adapter), body = requestBody(prompts['test.ask'], env.INTERVIEW_PREP_MODEL_ID);
  const s = g.begin();
  s.expect('test.ask', () => { throw Error('A fixture ran in the live lane'); }, p => assert.deepEqual(p, packet));
  const response = await post(g, body, { cookie: 'private-test-cookie', 'x-ignored': 'private-marker' });
  assert.deepEqual(JSON.parse(response.data.choices[0].message.content), { reply: 'Provider answer' });
  assert.deepEqual(received[0].body, body);
  assert.equal(received[0].url, '/v1/chat/completions'); assert.equal(received[0].headers.authorization, `Bearer ${key}`);
  assert.equal(received[0].headers.cookie, undefined); assert.equal(received[0].headers['x-ignored'], undefined);
  s.expect('test.ask', null, p => assert.equal(p.answer, 'must not forward this packet'));
  assert.equal((await post(g, body)).status, 422); assert.equal(received.length, 1);
  for (behavior of ['redirect', 'bad', 'echo-key']) {
    s.expect('test.ask', { reply: 'Never use the replay answer' }); assert.equal((await post(g, body)).status, 502);
  }
  await s.end();
  assert.equal(trapHits, 0);
  assert.deepEqual(codes(s), ['packet-assertion', 'model-http-307', 'invalid-model-completion', 'invalid-model-envelope']);
  const diagnostics = JSON.stringify([adapter, s]);
  for (const secret of [key, keyFile, packet.answer, 'Never use the replay answer', 'Provider answer'])
    assert.ok(!diagnostics.includes(secret));
});

test('the app subprocess receives no hosted configuration, operator proxy, search credentials or provider key', () => {
  const env = hostEnvironment({ Path: 'runtime', HTTP_PROXY: 'public', NO_PROXY: '*', AZURE_CLIENT_SECRET: 'secret',
    Kestrel__Endpoints__Public__Url: 'public', INTERVIEW_PREP_MODEL_KEY_FILE: 'private', INTERVIEW_PREP_SCOUT_BOARDS: 'public',
    DOTNET_STARTUP_HOOKS: 'external', INTERVIEW_PREP_BUILD: '../unsafe', INTERVIEW_PREP_WEBROOT: 'private' }, 'isolated', 3210);
  assert.equal(env.Path, 'runtime'); assert.equal(env.INTERVIEW_PREP_BUILD, 'Release'); assert.equal(env.TMPDIR, 'isolated');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3210');
  assert.doesNotMatch(JSON.stringify(env), /public|private|external|secret|unsafe|\*/i);
});

test('journeys isolate peers, send the actual revision, and distinguish a provider answer, fallback, rules and skips', async t => {
  let modelCalls = 0;
  const provider = await listener(t, async (req, res) => {
    for await (const _ of req) { /* drain the synthetic request */ }
    const obj = ++modelCalls === 1 ? { reply: 'From the loopback provider.' } : { unusable: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
  });
  const adapter = await modelAdapter('live', { INTERVIEW_PREP_MODEL_ID: 'test', INTERVIEW_PREP_MODEL_PORT: String(provider) });
  const g = await gatewayFor(t, adapter), writes = [], byCookie = new Map();
  const port = await listener(t, async (req, res) => {
    const state = byCookie.get(req.headers.cookie);
    let body = ''; for await (const chunk of req) body += chunk;
    const data = body && JSON.parse(body);
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!state) return send(401);
    if (req.url === '/api/workspace') return send(200, state);
    if (req.url === '/api/chats' && data.kind === 'plan') { state.owned = true; return send(200, { id: 'synthetic-id' }); }
    if (req.url === '/api/chats/synthetic-id' && state.owned)
      return send(200, { session: { revision: state.said ? 8 : 7 }, messages: [{ speaker: 'assistant', text: state.text ?? 'Updated', mode: state.mode ?? 'studio' }] });
    if (req.url === '/api/chats/synthetic-id/turns' && state.owned && data.revision === 7) {
      if (data.text === 'model turn') {
        const answer = await post(g, requestBody(prompts['test.ask'], 'test'));
        const { reply } = JSON.parse(answer.data.choices[0].message.content);
        state.mode = reply ? 'local model' : 'model unavailable · guided reply'; state.text = reply ?? 'Guided reply';
      }
      writes.push(data); state.said = true; return send(200, { id: 'synthetic-id' });
    }
    return send(404);
  });
  const host = { url: `http://127.0.0.1:${port}`, async open() { const cookie = `ws=${randomUUID()}`; byCookie.set(cookie, {}); return cookie; } };
  const modelTurn = async c => {
    const id = await c.start('plan'); c.expect('test.ask', null, p => assert.deepEqual(p, packet));
    return c.say(id, 'model turn');
  };
  const selected = catalog(suite(conversation('multi-turn', async c => {
    const id = await c.start('plan'); assert.equal((await c.say(id, packet.answer, { zone: 'UTC', action: 'say' })).session.revision, 8);
    const other = await c.peer(); assert.deepEqual(await other.state(), {});
    assert.equal((await other.request(`chats/${id}`)).status, 404);
  }), conversation('new-workspace', async c => { assert.deepEqual(await c.state(), {}); }),
  conversation('negative', async c => { await c.state(); assert.fail(packet.answer); }),
  conversation('intentional-outage', noop, { lanes: ['replay'] }),
  conversation('authored', async c => assert.equal((await modelTurn(c)).messages.at(-1).text, 'From the loopback provider.')),
  conversation('misleading-fallback', modelTurn)));
  const rows = caseRows(selected, 'live');
  await runCases({ selected, rows, lane: 'live', host, gateway: g });
  assert.equal(byCookie.size, 6); assert.equal(writes.length, 3);
  assert.deepEqual([writes[0].action, writes[0].zone, writes[0].text], ['say', 'UTC', packet.answer]); assert.ok(writes[0].requestId);
  assert.deepEqual(rows.map(r => [r.status, r.exercise]), [['passed', 'rules-only'], ['passed', 'rules-only'], ['failed', 'rules-only'],
    ['skipped', null], ['passed', 'model-exercising'], ['failed', 'model-exercising']]);
  assert.deepEqual(codes(rows[2]), ['case-assertion']); assert.equal(rows[3].reason, 'replay-only');
  assert.deepEqual(codes(rows[5]), ['application-fallback']);
  assert.equal(summarize({ lane: 'live', cases: rows }).liveModelPasses, 1);
  assert.ok(!JSON.stringify(rows).includes(packet.answer));
});

test('overlapping or abandoned API operations are drained and expired helpers cannot bleed into a later conversation', async t => {
  const g = await gatewayFor(t), port = await listener(t, (_req, res) => { res.end('{}'); });
  const host = { url: `http://127.0.0.1:${port}`, open: async () => `ws=${randomUUID()}` };
  let stale;
  const selected = catalog(suite(conversation('overlap', async c => {
    stale = c; const pending = c.state(); assert.throws(() => c.state(), /overlapping/); await pending;
  }), conversation('forgotten', async c => { void c.state(); }),
  conversation('current', async c => { assert.throws(() => stale.state(), /expired/); await c.state(); }),
  conversation('no-op', noop)));
  const rows = caseRows(selected, 'replay'); await runCases({ selected, rows, lane: 'replay', host, gateway: g });
  assert.deepEqual(rows.map(codes), [['overlapping-case-operations'], ['unfinished-case-operation'], [], ['empty-api-journey']]);
  assert.deepEqual(codes(g), ['expired-case-context']);
});

const hash = '0'.repeat(64), otherHash = '1'.repeat(64);
function exampleReport() {
  return { schema: 'interview-prep-eval/1', lane: 'live', model: { provider: 'loopback-openai-compatible', id: 'model', port: 4321 },
    settings: { transport: 'chat-completions-v1', temperature: 0, stream: false }, pack: { version: '1.0.0', digest: hash },
    corpus: { revision: 'uncommitted', fingerprint: hash }, apiBinarySha256: hash, evaluatorFingerprint: hash, failures: [], cases: [
      { id: 'scenario/quality', status: 'passed', exercise: 'model-exercising', calls: [
        { expected: 'test.ask', prompt: 'test.ask', settings: hash, outcome: 'live-completion' }], failures: [] },
      { id: 'scenario/rules', status: 'failed', exercise: 'rules-only', calls: [], failures: [{ code: 'case-assertion' }] }
    ] };
}

test('comparison flags a newly failing ID even if the net pass count is unchanged; mismatched evidence is not comparable', () => {
  const b = exampleReport(), c = structuredClone(b); c.pack = { version: '2.0.0', digest: otherHash };
  c.cases[0].status = 'failed'; c.cases[0].failures.push({ code: 'case-assertion' }); c.cases[1].status = 'passed'; c.cases[1].failures = [];
  assert.deepEqual(compare(b, c).regressions, [{ id: 'scenario/quality', reason: 'new-failure' }]);
  assert.deepEqual(compare(b, c).improvements, ['scenario/rules']);
  const different = mutation => { const x = structuredClone(b); mutation(x); assert.throws(() => compare(b, x)); };
  for (const mutation of [x => x.model.id = 'other', x => x.model.port++, x => x.lane = 'replay', x => x.corpus.fingerprint = otherHash,
    x => x.corpus.revision = 'different-revision', x => x.settings.temperature = 1, x => x.evaluatorFingerprint = otherHash,
    x => x.apiBinarySha256 = otherHash,
    x => x.cases.pop(), x => x.cases.push(x.cases[0]), x => x.cases[0].calls[0].settings = otherHash,
    x => x.cases[0].calls[0].outcome = 'replayed', x => x.cases[0].calls = [], x => x.failures.push({ code: 'setup-failed' })])
    different(mutation);
});

test('comparison distinguishes matching live revision attestations, unknown revisions and replay', () => {
  const b = exampleReport(), c = structuredClone(b);
  assert.equal(compare(b, c).modelRevisionStatus, 'unknown');
  b.model.revision = hash;
  assert.throws(() => compare(b, c), { message: 'different-model-revision' });
  assert.throws(() => compare(c, b), { message: 'different-model-revision' });
  c.model.revision = otherHash;
  assert.throws(() => compare(b, c), { message: 'different-model-revision' });
  c.model.revision = hash;
  assert.equal(compare(b, c).modelRevisionStatus, 'operator-attested-match');
  for (const bad of ['', null, undefined, [hash], { sha256: hash }, 42, hash + '\n', 'F'.repeat(64)]) {
    b.model.revision = c.model.revision = bad;
    assert.throws(() => compare(b, c), { message: 'invalid-report-model-revision' });
  }
  const replay = exampleReport();
  replay.lane = 'replay'; replay.model = { provider: 'replay-fixture', id: 'replay' };
  replay.cases[0].calls[0].outcome = 'replayed';
  assert.equal(compare(replay, replay).modelRevisionStatus, 'not-applicable');
  replay.model.revision = hash;
  assert.throws(() => compare(replay, replay), { message: 'invalid-report-model-revision' });
});

test('a rules-only pass cannot improve on a failure that exercised the model', () => {
  const b = exampleReport(), c = structuredClone(b);
  Object.assign(b.cases[0], { status: 'failed', failures: [{ code: 'case-assertion' }] });
  Object.assign(c.cases[0], { exercise: 'rules-only', calls: [] });
  const result = compare(b, c);
  assert.deepEqual(result.regressions, [{ id: 'scenario/quality', reason: 'lost-model-coverage' }]);
  assert.deepEqual(result.improvements, []);
});

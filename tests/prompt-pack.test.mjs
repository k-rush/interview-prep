import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate, build, install, loadPack } from '../scripts/prompt-pack.mjs';
import { localHost } from './local-host.mjs';

async function releases(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coach-prompt-test-')), store = join(dir, 'ring');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'default.json'), base = await build(file);
  await install(file, store);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.version = '999.1.1';
  for (const id of ['chat.search', 'chat.coach']) raw.prompts[id] += '\nSynthetic release marker.';
  const candidate = join(dir, 'candidate.json');
  await writeFile(candidate, JSON.stringify(raw) + '\n');
  const next = await install(candidate, store);
  return { dir, store, candidate, raw, base, next };
}

test('immutable compatible versions install independently; activation checks the serving predecessor', async t => {
  const { dir, store, candidate, raw, base, next } = await releases(t);
  await assert.rejects(loadPack(store), { code: 'ENOENT' });
  assert.equal((await install(candidate, store)).digest, next.digest);
  await activate(store, base.digest, 'none');
  await assert.rejects(activate(store, next.digest, 'none'), /changed/);
  await activate(store, next.digest, base.digest);
  await activate(store, next.digest, base.digest); // identical retry
  await assert.rejects(activate(store, base.digest, 'none'), /changed/);
  assert.equal((await loadPack(store)).digest, next.digest);

  const bad = join(dir, 'bad.json');
  await writeFile(bad, (await readFile(candidate, 'utf8')).replace('{"contract":', '{"contract":0,"contract":'));
  await assert.rejects(install(bad, store), /canonical artifact/);
  await writeFile(bad, JSON.stringify({ ...raw, prompts: { ...raw.prompts, 'chat.search': 'Different contents.' } }) + '\n');
  await assert.rejects(install(bad, store), /different digest/);
  delete raw.prompts['mock.assess'];
  await writeFile(bad, JSON.stringify(raw));
  await assert.rejects(install(bad, store), /contract/);
  await writeFile(join(store, 'releases', next.digest + '.json'), '{');
  await assert.rejects(loadPack(store));
  await activate(store, base.digest, next.digest);
  assert.equal((await loadPack(store)).digest, base.digest);
});

test('a running host pins one pack across recall calls, hot switches and rolls back without restart', async t => {
  const { store, base, next } = await releases(t);
  const seen = [];
  let switchDuringLookup = true;
  const gateway = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { messages } = JSON.parse(raw), packet = JSON.parse(messages[1].content);
      seen.push(messages[0].content);
      const lookup = !Object.hasOwn(packet, 'search_workspace');
      if (lookup && switchDuringLookup) {
        switchDuringLookup = false;
        await activate(store, next.digest, base.digest);
      }
      const value = lookup ? { tool: { name: 'search_workspace', query: 'Willow' } } :
        { turn: { reply: 'Your saved example mentions Willow.', kind: 'none', label: '' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
    } catch { res.writeHead(500).end(); }
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); return new Promise(resolve => gateway.close(resolve)); });
  await activate(store, base.digest, 'none');
  const app = await localHost(t, gateway.address().port, { INTERVIEW_PREP_PROMPT_STORE: store }), owner = await app.open();
  const serving = async () => (await (await fetch(app.url + '/healthz')).json()).promptPack;
  assert.deepEqual(await serving(), { version: base.version, digest: base.digest });
  const post = (path, body) => app.request(path, owner, 'POST', body);
  assert.ok((await post('evidence', { project: 'Willow', statement: 'I maintained the Willow checklist.' })).ok);
  const { id } = await (await post('chats', { kind: 'chat', requestId: randomUUID() })).json();
  for (const [revision, pack] of [base, next].entries()) {
    const r = await post(`chats/${id}/turns`, { text: 'What did I mention earlier about Willow?', revision, requestId: randomUUID() });
    assert.ok(r.ok);
    assert.deepEqual(seen.splice(0), [pack.prompts['chat.search'], pack.prompts['chat.coach']]);
    assert.equal((await serving()).digest, next.digest);
  }
  await activate(store, base.digest, next.digest);
  assert.equal((await serving()).digest, base.digest);
  await activate(store, next.digest, base.digest);
  assert.equal((await serving()).digest, next.digest);
  await writeFile(join(store, 'active'), '../not-a-digest\n');
  assert.equal((await serving()).digest, next.digest, 'invalid pointer must retain the last verified pack');
  await app.restart();
  assert.equal((await serving()).digest, base.digest, 'cold start must serve the embedded default');
});

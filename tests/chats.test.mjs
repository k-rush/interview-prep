import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { localHost } from './local-host.mjs';

function client(app, cookie) {
  async function json(path, method = 'GET', body) {
    const res = await app.request(path, cookie, method, body);
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${res.ok ? '' : await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  }
  const start = async kind => (await json('chats', 'POST', { kind, requestId: randomUUID() })).id;
  const send = (id, revision, text, action) => json(`chats/${id}/turns`, 'POST', { text, action, revision, requestId: randomUUID(), zone: 'UTC' });
  return { json, start, send, search: query => json('chats/search', 'POST', {query}) };
}

test('the coach calls owner-scoped recall, keeps notes separate, and never revives a corrected claim as evidence', async t => {
  const calls = [];
  const fixture = createServer(async (req,res) => {
    let raw = '';for await(const chunk of req) raw += chunk;
    const call = JSON.parse(raw), packet = JSON.parse(call.messages[1].content); calls.push(packet);
    const result = call.messages[0].content.includes('Select the read-only') ? {tool:{name:'search_workspace',query:'Moonrise'}} :
      {turn:{reply:'Which release decision did you own?',kind:'project',label:'Moonrise'}};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  });
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
  t.after(()=>{fixture.closeAllConnections();return new Promise(resolve=>fixture.close(resolve));});
  const app = await localHost(t,fixture.address().port), a = await app.open(), b = await app.open(), c = client(app,a), other = client(app,b);
  await other.json('evidence','POST',{project:'Moonrise',statement:'Secret from the other fixture'});
  const id = await c.start(), first = {revision:0,requestId:randomUUID(),text:'Project: Moonrise. I built a rollout checklist.'};
  await c.json(`chats/${id}/turns`,'POST',first); await c.json(`chats/${id}/turns`,'POST',first);
  assert.equal((await app.request(`chats/${id}/turns`,a,'POST',{...first,text:'Changed payload'})).status,409);
  const detail = await c.json(`chats/${id}`); assert.equal(detail.messages.length,3); assert.equal(detail.messages.at(-1).mode,'local model');
  assert.equal((await app.request(`chats/${id}`,b)).status,404);
  let [fact] = (await app.state(a)).facts;
  assert.equal(fact.claim,first.text); assert.equal(fact.confirmed,false);assert.equal(fact.allowDrafts,false);
  const { nodes } = await c.json('experience');assert.deepEqual(nodes.map(n=>[n.kind,n.label]),[['project','Moonrise']]);
  await c.json(`evidence/${fact.id}/confirm`,'POST',{claim:'I maintained the Moonrise runbook.'});
  await c.send(id,1,'Remember: Keep coaching questions short.');
  assert.equal((await app.state(a)).facts.length,1);
  const memories = await c.json('chats/memory'), note = memories.find(n=>n.factId===null);
  assert.equal(memories.find(n=>n.factId===fact.id).text,'I maintained the Moonrise runbook.');
  assert.deepEqual(await other.json('chats/memory'),[]);
  assert.equal((await app.request(`chats/memory/${note.id}`,b,'PUT',{text:'Different owner'})).status,404);
  assert.equal((await app.request(`chats/memory/${note.id}`,b,'DELETE')).status,404);
  await c.json(`chats/memory/${note.id}`,'PUT',{text:'Use bullet points.'});
  const next = await c.start();await c.send(next,0,'What did I mention earlier about Moonrise?');
  assert.ok(calls.some(p=>p.message?.includes('mention earlier') && !p.search_workspace));
  const recall = calls.at(-1).search_workspace;
  assert.ok(recall.some(h=>h.kind==='confirmed fact' && h.text==='I maintained the Moonrise runbook.'));
  assert.ok(!JSON.stringify(calls).includes('Secret from the other fixture'));assert.ok(!recall.some(h=>h.text===first.text));
  assert.ok(calls.at(-1).notes.includes('Use bullet points.') && !calls.at(-1).notes.includes('Keep coaching questions short.'));
  const fork = await c.send(next,1,'Start a mock interview');assert.notEqual(fork.id,next);assert.equal((await c.json(`chats/${fork.id}`)).session.kind,'mock');
  await c.json(`chats/memory/${note.id}`,'DELETE');assert.deepEqual(await c.search('bullet points'),[]);
  await app.restart();assert.equal((await c.json(`chats/${id}`)).messages.length,5);
  await c.json(`chats/${id}`,'DELETE'); assert.deepEqual((await app.state(a)).facts,[]);
});

test('chat mocks file cited answers without changing complete or explicitly incomplete scorecards', async t => {
  const app = await localHost(t), a = await app.open(), c = client(app,a);
  const first = await c.start('mock');await c.send(first,0,'Engineer');await c.send(first,1,'I built a service.');await c.send(first,2,'','finish');
  const partial = await c.json(`chats/${first}`);assert.match(partial.messages.at(-1).text,/1\/4 questions answered.*insufficient evidence/s);
  const second = await c.start('mock');assert.notEqual(second,first);
  for (const [i,text] of ['Engineer','I owned the rollout.','I chose a pilot instead of a launch because of risk.','The number of tickets fell after the pilot.','I designed the service when customers needed it.'].entries()) await c.send(second,i,text);
  const full = await c.json(`chats/${second}`);assert.equal(full.session.state,'closed');assert.match(full.messages.at(-1).text,/Practice scorecard.*Simulated (no-)?hire/s);
  assert.match(full.messages.at(-1).text,/Offline wording checklist/);
  const ws = await app.state(a);assert.equal(ws.facts.length,5);assert.equal(ws.mocks.find(m=>m.id===second).report.marks.length,4);
  assert.ok(ws.facts.every(f=>!f.confirmed && !f.allowDrafts && !f.allowLive));
  assert.deepEqual((await c.json('chats/memory')).map(m=>m.factId).sort(),ws.facts.map(f=>f.id).sort());
  await c.json(`chats/${second}`,'DELETE');assert.equal((await app.state(a)).mocks.length,1);
  assert.deepEqual((await c.json('chats/memory')).map(n=>n.text),['I built a service.']);
});

test('one ordinary chat builds history, rehearses an interview and can switch to job search without creating a mock', async t => {
  const app = await localHost(t), a = await app.open(), c = client(app,a), id = await c.start();
  const thread = () => c.json(`chats/${id}`), memory = () => c.json('chats/memory');
  await c.send(id,0,'Help me add experience to my job history.');
  const claim = 'Project: Moonrise. In my previous role I led the migration.';
  await c.send(id,1,claim);
  const [first] = (await app.state(a)).facts;
  await c.json(`evidence/${first.id}/confirm`,'POST',{claim,allowDrafts:true});
  await c.send(id,2,'Go through an example interview question with me.');
  assert.match((await thread()).messages.at(-1).text,/without a score/);
  await c.send(id,3,claim);
  await c.send(id,4,'Support tickets fell after the pilot.');
  const state = await app.state(a);
  assert.equal(state.mocks.length,0);assert.equal((await thread()).session.kind,'chat');
  assert.deepEqual(state.facts.map(f=>[f.project,f.claim,f.allowDrafts]).sort(),[
    ['Moonrise',claim,true],['Moonrise','Support tickets fell after the pilot.',false]
  ].sort());
  assert.equal((await memory()).length,2);
  const linked = (await memory()).find(n=>n.factId===first.id);
  await c.json(`chats/memory/${linked.id}`,'PUT',{text:'Ask about migration decisions.'});
  await c.json(`chats/memory/${linked.id}`,'DELETE');
  assert.equal((await app.state(a)).facts.find(f=>f.id===first.id).claim,claim);
  await c.send(id,5,'Find jobs that are a close match for my experience.');
  assert.match((await thread()).messages.at(-1).text,/public job title/);
  await c.send(id,6,'cancel');assert.equal((await thread()).session.state,'active');
  assert.equal((await c.json('chats')).length,1);
  const [remaining] = await memory();
  await c.json(`chats/memory/${remaining.id}`,'PUT',{text:'Ask how I measured the pilot.'});
  const {id:merged} = await c.json('experience/merge','POST',{left:state.facts[0],right:state.facts[1],claim:'I led the Moonrise migration and tracked tickets.'});
  assert.deepEqual((await memory()).map(n=>[n.factId,n.text]),[[merged,'Ask how I measured the pilot.']]);
});

test('an independently corroborated statement and its edited memory survive deletion of the original chat', async t => {
  const app = await localHost(t), a = await app.open(), c = client(app,a);
  const id = await c.start(), mock = await c.start('mock'), claim = 'I built the project dashboard.';
  await c.send(id,0,claim); const [original] = (await app.state(a)).facts;
  await c.json(`evidence/${original.id}/confirm`,'POST',{claim,allowDrafts:true});
  await c.send(mock,0,'Engineer');await c.send(mock,1,claim);
  const [memory] = await c.json('chats/memory');
  await c.json(`chats/memory/${memory.id}`,'PUT',{text:'Ask about dashboard design.'});
  await c.json(`chats/${id}`,'DELETE');
  const [survivor] = (await app.state(a)).facts;
  assert.equal(survivor.id,original.id);assert.match(survivor.source,/Mock answer 1/);
  assert.equal(survivor.allowDrafts,false);assert.equal(survivor.confirmed,false);
  assert.deepEqual((await c.json('chats/memory')).map(m=>m.text),['Ask about dashboard design.']);
  await c.json(`mocks/${mock}`,'DELETE');
  assert.deepEqual((await app.state(a)).facts,[]);assert.deepEqual(await c.json('chats/memory'),[]);
});

test('an ordinary conversation saves an interview target and books mock blocks only after confirmation', async t => {
  const app = await localHost(t), c = client(app,await app.open()), id = await c.start();
  const day = new Date(Date.now()+9*86400000).toISOString().slice(0,10);
  for (const [i,text] of ['I have an upcoming interview','Fictional Orchard','Designer','Improve accessibility.',`${day} 14:00`,'no'].entries()) await c.send(id,i,text);
  const {session,messages} = await c.json(`chats/${id}`);assert.match(messages.at(-1).text,/Prep packet/);
  const target = (await c.json('targets')).find(t=>t.id===session.targetId);assert.equal(target.interviewAt.slice(0,10),day);
  const progress = `targets/${target.id}/progress`;assert.equal((await c.json(progress)).plan,null);
  await c.send(id,6,'confirm');const {plan} = await c.json(progress);assert.ok(plan.blocks.length>0);
  const payload = {kind:'mock',targetId:target.id,blockId:plan.blocks[0].id,requestId:randomUUID()};
  const started = await c.json('chats','POST',payload);assert.equal((await c.json('chats','POST',{...payload,requestId:randomUUID()})).id,started.id);
  assert.equal((await c.json(`chats/${started.id}`)).session.targetId,target.id);
});

test('streamed previews lose to a concurrent committed turn; retries preserve status and idempotency', {timeout:30000}, async t => {
  let finish, calls = 0;
  const fixture = createServer(async (req, res) => {
    for await (const _ of req) {}
    calls++;
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const delta = content => res.write(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`);
    delta('{"turn":{"reply":"Which part');
    finish = () => { delta(' was yours?","kind":"none","label":""}}'); res.end('data: [DONE]\n\n'); };
  });
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
  t.after(() => {fixture.closeAllConnections();return new Promise(resolve=>fixture.close(resolve));});
  const app = await localHost(t,fixture.address().port), owner = await app.open(), c = client(app,owner), id = await c.start();
  const stream = body => app.request(`chats/${id}/turns`,owner,'POST',body,{Accept:'application/x-ndjson'});
  const events = async res => (await res.text()).trim().split('\n').map(line=>JSON.parse(line));
  const input = {revision:0, requestId:randomUUID(), text:'Project: Unsaved preview.'};
  const response = await stream(input);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const winner = {...input, requestId:randomUUID(), text:'Remember: Keep it short.'};
  const [preview,done] = await events(await stream(winner));
  assert.equal(done.type,'done'); assert.equal(done.id,id);
  assert.deepEqual(preview,{type:'delta',text:done.text});
  finish();
  const frames = await events(response), error = frames.at(-1);
  assert.deepEqual(frames[0],{type:'delta',text:'Which part'});
  assert.equal(error.type,'error'); assert.equal(error.status,409);
  const detail = await c.json(`chats/${id}`);
  assert.equal(detail.messages.length,3); assert.equal(detail.messages.at(-1).text,done.text);
  assert.deepEqual((await app.state(owner)).facts,[]);
  assert.equal((await stream(input)).status,409);
  assert.deepEqual(await events(await stream(winner)),[preview,done]);
  assert.equal(calls,1);
});

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
  const id = await c.start('builder'), first = {revision:0,requestId:randomUUID(),text:'Project: Moonrise. I built a rollout checklist.'};
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
  const note = (await c.json('chats/memory'))[0];assert.deepEqual(await other.json('chats/memory'),[]);
  const next = await c.start('builder');await c.send(next,0,'What did I mention earlier about Moonrise?');
  assert.ok(calls.some(p=>p.message?.includes('mention earlier') && !p.search_workspace));
  const recall = calls.at(-1).search_workspace;
  assert.ok(recall.some(h=>h.kind==='confirmed fact' && h.text==='I maintained the Moonrise runbook.'));
  assert.ok(!JSON.stringify(calls).includes('Secret from the other fixture'));assert.ok(!recall.some(h=>h.text===first.text));
  const fork = await c.send(next,1,'Start a mock interview');assert.notEqual(fork.id,next);assert.equal((await c.json(`chats/${fork.id}`)).session.kind,'mock');
  await c.json(`chats/memory/${note.id}`,'DELETE');assert.deepEqual(await c.search('Keep coaching questions short'),[]);
  await app.restart();assert.equal((await c.json(`chats/${id}`)).messages.length,5);
  await c.json(`chats/${id}`,'DELETE'); assert.deepEqual((await app.state(a)).facts,[]);
});

test('chat mocks close with complete or explicitly incomplete scorecards and never auto-file answers', async t => {
  const app = await localHost(t), a = await app.open(), c = client(app,a);
  const first = await c.start('mock');await c.send(first,0,'Engineer');await c.send(first,1,'I built a service.');await c.send(first,2,'','finish');
  const partial = await c.json(`chats/${first}`);assert.match(partial.messages.at(-1).text,/1\/4 questions answered.*insufficient evidence/s);
  const second = await c.start('mock');assert.notEqual(second,first);
  for (const [i,text] of ['Engineer','I owned the rollout.','I chose a pilot instead of a launch because of risk.','The number of tickets fell after the pilot.','I designed the service when customers needed it.'].entries()) await c.send(second,i,text);
  const full = await c.json(`chats/${second}`);assert.equal(full.session.state,'closed');assert.match(full.messages.at(-1).text,/Practice scorecard.*Simulated (no-)?hire/s);
  assert.match(full.messages.at(-1).text,/Offline wording checklist/);
  const ws = await app.state(a);assert.equal(ws.facts.length,0);assert.equal(ws.mocks.find(m=>m.id===second).report.marks.length,4);
  await c.json(`chats/${second}`,'DELETE');assert.equal((await app.state(a)).mocks.length,1);
});

test('chat scout returns a dated digest, stated compensation and both reviewable drafts without auto applying', async t => {
  const app = await localHost(t), c = client(app,await app.open());
  const claim = 'I used SQL to check fictional forecasts.';
  const {id:fid} = await c.json('evidence','POST',{project:'Forecasts',statement:claim});
  await c.json(`evidence/${fid}/confirm`,'POST',{claim,allowDrafts:true});
  await c.json('discovery/listings','POST',{permitPrivateUse:true,title:'Data analyst',employer:'Example',pay:'Posted range: 80–90k',must:'SQL'});
  const id = await c.start('scout');await c.send(id,0,'Data analyst');
  const report = await c.json(`chats/${id}`);assert.equal(report.session.state,'closed');assert.match(report.messages.at(-1).text,/1 matching listing/);
  const {digests:[d]} = await c.json(`discovery?digestId=${report.session.digestId}`);
  assert.match(d.matches[0].listing.pay,/80–90k/);assert.equal(d.matches[0].fit.earned,d.matches[0].fit.possible);
  const p = await c.json(`discovery/drafts/${d.matches[0].packets[0].id}`);
  assert.ok(p.resume.includes(claim) && p.letter.includes(claim));assert.equal(p.approved,false);
  await c.json(`evidence/${fid}`,'DELETE');assert.ok(!(await c.json(`discovery?digestId=${d.id}`)).digests[0].matches[0].packets[0].current);
  const daily = await c.start('scout');
  for (const [i,text] of ['daily','Data analyst','08:30'].entries()) await c.send(daily,i,text);
  assert.equal((await c.json('discovery')).settings.enabled,false);
  await c.send(daily,3,'confirm');
  const s = (await c.json('discovery')).settings;assert.deepEqual([s.enabled,s.localTime,s.zone,s.autoDraft],[true,'08:30','UTC',true]);
  assert.equal((await c.json(`chats/${daily}`)).session.digestId,d.id);
});

test('an ordinary builder conversation saves an interview target and books mock blocks only after confirmation', async t => {
  const app = await localHost(t), c = client(app,await app.open()), id = await c.start('builder');
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

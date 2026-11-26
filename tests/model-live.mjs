import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { localHost } from './local-host.mjs';

test('local AI describes and files a whole unlabelled document', async t => {
  const port = process.env.INTERVIEW_PREP_MODEL_PORT;
  assert.ok(port, 'Connect a local model first');
  const app = await localHost(t, port, Object.fromEntries(['INTERVIEW_PREP_MODEL_ID','INTERVIEW_PREP_MODEL_KEY_FILE']
    .filter(k => process.env[k]).map(k => [k, process.env[k]])));
  const cookie = await app.open();
  const text = 'I worked as a Platform engineer.\nI designed the rehearsal for Project Atlas.\nI wrote a rollback checklist for the team.';
  const response = await app.request('experience/documents', cookie, 'POST', { fileName: 'notes.txt', passages: [{location:'Lines 1-3', text}] });
  assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  const {id} = await response.json();
  const run = await app.request(`chats/${id}/import`, cookie, 'POST');
  assert.equal(run.status, 200, run.ok ? undefined : await run.text());
  assert.match((await (await app.request(`chats/${id}`,cookie)).json()).messages.at(-1).text,/searched your job history/i);
  const { nodes, sources, citations } = await (await app.request('experience', cookie)).json();
  assert.match(sources[0].description, /engineer|Atlas|rehearsal|checklist/i);
  assert.ok(nodes.some(n => n.kind === 'role' && /engineer/i.test(n.label)));
  assert.ok(nodes.some(n => n.kind === 'project' && /Atlas/i.test(n.label)));
  const { facts } = await app.state(cookie);
  assert.ok(facts.length >= 2 && facts.every(f => text.includes(f.claim) && !f.confirmed && !f.allowDrafts && !f.allowLive));
  assert.ok(citations.every(c => c.location === 'Lines 1-3' && c.sourceId === sources[0].id));
});

// Opt-in local hardware smoke, separate from deterministic replay. All inputs and storage are synthetic.
test('real local model conducts a conversation, asks adaptive probes and returns a cited assessment', async t => {
  const port = process.env.INTERVIEW_PREP_MODEL_PORT;
  assert.ok(port, 'Connect a local model first');
  const app = await localHost(t,port,Object.fromEntries(['INTERVIEW_PREP_MODEL_ID','INTERVIEW_PREP_MODEL_KEY_FILE']
    .filter(k=>process.env[k]).map(k=>[k,process.env[k]])));
  const cookie = await app.open();
  async function post(path,body) {
    const res = await app.request(path,cookie,'POST',body);assert.ok(res.ok,`${path}: ${res.status}`);
    return res.json();
  }
  const get = async id => (await app.request(`chats/${id}`,cookie)).json();
  const say = (id,revision,text)=>post(`chats/${id}/turns`,{text,revision,requestId:randomUUID(),zone:'UTC'});
  await post('experience/sources',{category:'resume',title:'Synthetic resume',reviewed:true,useModel:true,excerpts:[
    {location:'First line',text:'I worked as a Platform engineer.'},{location:'Second line',text:'I designed the rehearsal for Project Atlas.'}]});
  const library=await (await app.request('experience',cookie)).json();
  assert.ok(library.nodes.some(n=>n.kind==='role' && /engineer/i.test(n.label)),'The named role was not filed');
  assert.ok(library.nodes.some(n=>n.kind==='project' && /Atlas/i.test(n.label)),'The named project was not filed');
  const {id:builder} = await post('chats',{kind:'builder',requestId:randomUUID()});
  await say(builder,0,'I built a checklist for a fictional release rehearsal.');
  const reply = (await get(builder)).messages.at(-1);
  assert.equal(reply.mode,'local model');assert.ok(reply.text.includes('?'));
  const {id} = await post('chats',{kind:'mock',requestId:randomUUID()});
  const answers=['I designed a rollout checklist. My team ran the pilot.',
    'I chose a pilot instead of a full rollout because the deadline limited testing.',
    'I checked incident reports. There were fewer failed releases after the pilot.',
    'During a risky release I wrote the checklist. The team used it and fewer releases failed.'];
  await say(id,0,'Platform engineer');
  for (const [i,answer] of answers.entries()) await say(id,i+1,answer);
  const chat = await get(id), m = (await app.state(cookie)).mocks.find(m=>m.id===id);
  assert.ok(chat.messages.some(m=>m.mode==='local model'));
  assert.equal(chat.session.state,'closed');assert.equal(m.report.assessor,'local','Actual model assessment was unavailable or invalid');
  assert.ok(m.report.marks.every((m,i)=>answers[i].includes(m.quote)));
});

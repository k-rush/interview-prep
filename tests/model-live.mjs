import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { localHost } from './local-host.mjs';

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

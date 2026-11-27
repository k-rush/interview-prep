import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localHost } from './local-host.mjs';

const target = { role: 'Platform engineer', company: 'Amazon', level: 'Senior', round: 'Hiring manager', description: 'Build reliable releases.' };
const answers = ['During the release, I wrote the checklist; my team tested it.',
  'I chose a pilot rather than a single release because rollback risk was high.',
  'I compared the support tickets before and after the pilot. Failures fell.',
  'Initially our releases stalled. I introduced rehearsals and the failures dropped.'];
const day = 86400000, min = 60000;

test('a scheduled mock resumes, finishes its block, and enters only a comparable readiness series', async t => {
  const app = await localHost(t), owner = await app.open(), other = await app.open();
  const post = (p,b) => app.request(p,owner,'POST',b);
  const {id} = await (await post('targets',target)).json(), path = `targets/${id}`;
  assert.equal((await app.request(`${path}/progress`,other)).status,404);
  let year = new Date().getUTCFullYear();
  const transition = () => {
    const first = new Date(Date.UTC(year,10,1,8)); return +first + ((7-first.getUTCDay())%7)*day;
  };
  if (transition()-3*day <= Date.now()) year++;
  const end = transition(), iso = ms => new Date(ms).toISOString();
  const windows = [-2,-1,0,1].map(i=>({start:iso(end+i*day),end:iso(end+i*day+90*min)}));
  const input = {windows,zone:'America/Chicago',interviewAt:iso(end+2*day)};
  assert.equal((await post(`${path}/schedule/confirm`,{...input,windows:[windows[0],windows[0]]})).status,400);
  const progress = async ()=>(await app.request(`${path}/progress`,owner)).json();
  const preview = await (await post(`${path}/schedule/preview`,input)).json();
  assert.equal((await progress()).plan,null);
  assert.deepEqual(preview.blocks.map(b=>b.kind),['mock','review','mock','drill']);
  for(const [i,b] of preview.blocks.entries()) assert.ok(+new Date(b.startsAt)>=+new Date(windows[i].start) &&
    +new Date(b.startsAt)+min*b.minutes<=+new Date(windows[i].end));
  assert.equal((await post(`${path}/schedule/confirm`,input)).status,204);
  const plan=(await progress()).plan, [baseline,review,followup] = plan.blocks;
  const today=(await (await app.request('today',owner)).json()).next;
  assert.equal(today.targetId,id);assert.equal(today.label,'Baseline mock');assert.equal((await (await app.request('today',other)).json()).next,null);
  assert.equal((await post(`blocks/${review.id}`,{action:'move',startsAt:input.interviewAt})).status,400);
  assert.equal((await post(`blocks/${baseline.id}`,{action:'done'})).status,400);
  const start = async blockId=>(await (await post('mocks',{targetId:id,blockId})).json()).id;
  const finish = async (mid,text,assessor) => {
    for(const [index,answer] of text.entries())
      assert.equal((await post(`mocks/${mid}/answers`,{index,text:answer})).status,204);
    assert.equal((await post(`mocks/${mid}/report`,assessor)).status,204);
  };
  const first=await start(baseline.id);
  assert.equal(await start(baseline.id),first);
  assert.equal((await progress()).readiness,'Not assessed');
  await finish(first,[...answers.slice(0,2),'I do not know.',answers[3]],{assessor:'wording-v1'});
  let trend=await progress();
  assert.equal(trend.readiness,'Needs practice');assert.equal(trend.delta,null);
  assert.equal(trend.plan.blocks[0].state,'done');
  const second=await start(followup.id);
  await finish(second,answers,{assessor:'wording-v1'});
  const self=await start();
  await finish(self,answers,{assessor:'self',points:[0,0,0,0]});
  trend=await progress();
  assert.equal(trend.readiness,'On track: one passing mock');
  assert.equal(trend.comparable,2);assert.equal(trend.delta,18.75);assert.equal(trend.competencies[2].delta,3);
  assert.equal((await post(`${path}/schedule/confirm`,input)).status,204);
  assert.deepEqual((await progress()).plan.blocks.filter(b=>b.kind==='mock').map(b=>b.attemptId),[first,second]);

  const report=(await app.state(owner)).mocks.find(m=>m.id===second).report;
  const opinion={turn:2,excerpt:'Failures fell.',note:'The observation came from support tickets.',askLocalCoach:false};
  assert.equal((await post(`mocks/${second}/challenges`,{...opinion,excerpt:'invented statistic'})).status,400);
  assert.equal((await post(`mocks/${second}/challenges`,opinion)).status,204);
  const feedback = {item:'Impact',vote:'down',reason:'unfair grade'};
  assert.equal((await post(`mocks/${second}/feedback`,feedback)).status,204);
  const reviewState=await (await app.request(`mocks/${second}/review`,owner)).json();
  assert.equal(reviewState.challenges[0].note,opinion.note);assert.deepEqual(reviewState.votes,[feedback]);
  assert.equal((await app.request(`mocks/${second}/review`,other)).status,404);
  const proposal={index:2,excerpt:'Failures fell.',project:'Pilot'};
  for(let i=0;i<2;i++) assert.equal((await post(`mocks/${second}/proposals`,proposal)).status,204);
  const final = await app.state(owner);
  assert.deepEqual(final.facts.map(f=>f.claim).sort(),[...answers,proposal.excerpt].sort());
  assert.ok(final.facts.every(f=>!f.confirmed && !f.allowDrafts));
  assert.deepEqual(final.mocks.find(m=>m.id===second).report,report);
  assert.equal((await app.request(`mocks/${second}`,other,'DELETE')).status,404);
  assert.equal((await app.request(`mocks/${second}`,owner,'DELETE')).status,204);
  assert.deepEqual((await app.state(owner)).facts.map(f=>f.claim).sort(),[...answers].sort());
  assert.equal((await progress()).comparable,1);
  assert.equal((await progress()).plan.blocks.find(b=>b.label==='Follow-up mock').state,'skipped');
});

test('research distinguishes official references from licensed themes; reminders expire on evidence correction', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-catalog-')), file=join(dir,'licensed.json');
  const theme = {company:'Amazon',publisher:'Test catalog',url:'https://example.org/licensed',theme:'A synthetic interview theme.'};
  await writeFile(file,JSON.stringify([{...theme,expiresAt:'2001-01-01T00:00:00Z'},{...theme,expiresAt:new Date(Date.now()+day)}]));
  t.after(async()=>{await unlink(file);await rmdir(dir);});
  const app=await localHost(t,undefined,{INTERVIEW_PREP_LICENSED_THEMES:file}), owner=await app.open(), other=await app.open();
  const post=(p,b,who=owner)=>app.request(p,who,'POST',b);
  const {id}=await (await post('targets',target)).json(), path=`targets/${id}`;
  assert.equal((await post(`${path}/research`,{publicCompanyLookup:false})).status,400);
  assert.equal((await post(`${path}/research`,{publicCompanyLookup:true})).status,204);
  const [saved]=await (await app.request('targets',owner)).json();
  assert.equal(saved.sources.filter(s=>s.title===theme.publisher).length,1);
  assert.ok(saved.sources.some(s=>s.title.includes('Leadership Principles')));
  assert.match(saved.researchStatus,/not a fresh search/);
  const {id:fact}=await (await post('evidence',{project:'Secret project',statement:'I tested the guide.'})).json();
  const deck={approved:true,cards:[{topic:'Impact',factId:fact,label:'pilot'},{topic:'Clarity'}]};
  assert.equal((await post(`${path}/deck`,deck)).status,400);
  const update=(claim,allowLive)=>post(`evidence/${fact}/confirm`,{claim,allowLive});
  await update('I tested the guide.',true);
  assert.equal((await post(`${path}/deck`,deck,other)).status,404);assert.equal((await post(`${path}/deck`,deck)).status,204);
  const lines=async()=>(await (await app.request(`${path}/deck`,owner)).json()).map(x=>x.line);
  assert.deepEqual(await lines(),['Mention pilot.','Start with the situation.']);
  await update('I tested the pilot guide.',true);assert.deepEqual(await lines(),['Start with the situation.']);
  await post(`${path}/deck`,deck);await update('I tested the pilot guide.',false);await update('I tested the pilot guide.',true);
  assert.deepEqual(await lines(),['Start with the situation.']);
  assert.equal((await app.state(owner)).mocks.length,0);
});

test('practice dictation only forwards bounded local PCM and never submits a caption as an answer', async t=>{
  let calls=0;
  const fixture=createServer(async(req,res)=>{
    calls++;for await(const _ of req) {}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'Fictional practice caption.'}));
  });
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  t.after(()=>{fixture.closeAllConnections();return new Promise(r=>fixture.close(r));});
  const app=await localHost(t,undefined,{INTERVIEW_PREP_SPEECH_PORT:String(fixture.address().port)}), cookie=await app.open();
  const upload=body=>fetch(`${app.url}/api/speech/transcribe`,{method:'POST',headers:{cookie,'X-Practice-Request':'1','Content-Type':'audio/wav'},body});
  assert.equal((await upload(Buffer.alloc(64))).status,400);assert.equal(calls,0);
  const wave=Buffer.alloc(44+64000);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);
  wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);
  wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
  const valid=await upload(wave);assert.equal(valid.status,200);assert.equal((await valid.json()).text,'Fictional practice caption.');
  assert.equal(calls,1);assert.deepEqual((await app.state(cookie)).mocks,[]);
});

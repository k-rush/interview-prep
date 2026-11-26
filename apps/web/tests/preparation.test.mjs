import assert from 'node:assert/strict';
import test from 'node:test';
import { localHost } from '../../../tests/local-host.mjs';
import { launchBrowser } from './browser.mjs';

test('a candidate can plan a round, open an approved manual reminder, and decline remote speech', async t=>{
  const app=await localHost(t), browser=await launchBrowser(t), page=await browser.newPage({timezoneId:'UTC'});
  const errors=[], remote=[], speechRequests=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const {origin,pathname}=new URL(route.request().url());
    if(origin!==app.url){remote.push(origin);return route.abort();}
    if(pathname.startsWith('/api/speech'))speechRequests.push(pathname);
    return route.continue();
  });
  await page.addInitScript(()=>{
    window.micStarts=0;
    Object.defineProperty(window,'SpeechRecognition',{value:class {start(){window.micStarts++;throw Error('Network recognizer must not start');}}});
    navigator.mediaDevices.getUserMedia=async()=>{window.micStarts++;throw Error('Microphone must not start');};
  });
  await page.goto(app.url);await page.getByRole('button',{name:'Open my local workspace'}).click();
  const tab=name=>page.getByRole('navigation',{name:'Workspace sections'}).getByRole('link',{name,exact:true}).click();
  await tab('Targets & schedule');
  await page.getByLabel('Target role').fill('Platform engineering');await page.getByLabel('Public company name').fill('Amazon');
  await page.getByLabel('Job description or goal').fill('Improve release reliability.');
  await page.getByRole('button',{name:'Save target'}).click();
  await page.getByRole('button',{name:'Research this public company name'}).click();
  await page.getByRole('link',{name:'Amazon Leadership Principles'}).waitFor();
  const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  await page.getByLabel('Interview date and time').fill(`${date}T18:00`);
  await page.getByLabel('Availability 1 start').fill(`${date}T14:00`);
  await page.getByLabel('Availability 1 end').fill(`${date}T16:00`);
  await page.getByRole('button',{name:'Preview schedule'}).click();
  await page.getByRole('button',{name:'Confirm schedule'}).click();
  await page.getByRole('button',{name:'Export calendar with reminders'}).waitFor();
  await tab('Live reminders');
  await page.getByLabel('I approve these exact cards').check();
  await page.getByRole('button',{name:'Save approved deck'}).click();
  await page.getByLabel('Notes and this guide are permitted').check();
  await page.getByRole('button',{name:'Open manual guide'}).click();
  await page.locator('.live-cue').getByText('What changed as a result?').waitFor();
  await page.getByRole('button',{name:'Covered'}).click();await page.getByText('No remaining cue.').waitFor();
  await page.getByRole('button',{name:'End guide'}).click();
  assert.deepEqual(speechRequests,[]);
  await tab('Targets & schedule');
  await page.getByRole('button',{name:'Start scheduled mock'}).first().click();
  await page.getByLabel('Your answer',{exact:true}).fill('I built the release rehearsal.');
  await page.getByRole('button',{name:'Dictate locally'}).click();
  await page.getByText(/No on-device English speech pack/).waitFor();
  assert.equal(await page.getByLabel('Your answer',{exact:true}).inputValue(),'I built the release rehearsal.');
  assert.equal(await page.evaluate(()=>window.micStarts),0);
  assert.ok(!speechRequests.includes('/api/speech/transcribe'));
  assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
});

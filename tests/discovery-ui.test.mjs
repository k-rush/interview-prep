import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchBrowser } from '../apps/web/tests/browser.mjs';
import { localHost } from './local-host.mjs';

test('search in normal chat ranks public links locally, asks once about daily runs and shares the Account setting', async t => {
  const dir = await mkdtemp(join(tmpdir(),'public-job-search-')), file = join(dir,'response.json');
  const titles = ['Data analyst - merchandising', 'Data analyst - SQL'];
  await writeFile(file,JSON.stringify({status:'completed',output:[
    {type:'web_search_call',status:'completed'},
    {type:'message',role:'assistant',content:[{type:'output_text',annotations:titles.map((title,i)=>({
      type:'url_citation',title,url:`https://careers.example.org/postings/${i}`
    }))}]}
  ]}));
  t.after(async()=>{await unlink(file);await rmdir(dir);});
  const app = await localHost(t,undefined,{INTERVIEW_PREP_SCOUT_SEARCH_REPLAY_FILE:file});
  const browser = await launchBrowser(t), page = await browser.newPage({timezoneId:'UTC'});
  const errors = [];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===app.url ? r.continue() : r.abort());
  await page.goto(app.url);await page.getByRole('button',{name:'Open my local workspace'}).click();
  const input = page.getByLabel('Message your coach'), transcript = page.getByRole('list',{name:'Chat transcript'});
  const say = async text => {
    await input.fill(text);await input.press('Enter');
    await transcript.locator('li.user').last().getByText(text,{exact:true}).waitFor();
    await page.locator('ol[aria-label="Chat transcript"][aria-busy="false"]').waitFor();
  };
  await say('Remember: I prefer SQL work.');
  await say('Find jobs that are a close match for my experience.');
  await transcript.getByText(/What public job title/).waitFor();
  await say('Data analyst');
  const report = page.getByRole('link',{name:titles[1],exact:true});
  await report.waitFor();
  assert.equal(await page.locator('ol').filter({has:report}).getByRole('link').first().textContent(),titles[1]);
  await transcript.getByText(/Would you like me to search for Data analyst daily/).waitFor();
  await say('yes');await transcript.getByText(/Daily search is on/).waitFor();
  const chat = page.url();
  await say('Find jobs that are a close match for my experience.');
  await transcript.getByText(/Search for “Data analyst”/).waitFor();
  await say('yes');
  await transcript.locator('li.assistant').last().getByText(/Job search report/).waitFor();
  assert.equal(page.url(),chat);assert.equal(await transcript.getByText(/Would you like me to search for Data analyst daily/).count(),1);
  await page.getByRole('link',{name:/^Account Settings/}).click();
  const setting = page.getByRole('checkbox',{name:'Run my job search daily'});
  await setting.waitFor();assert.ok(await setting.isChecked());
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/account/daily-search') && r.request().method()==='PUT' && r.ok()),setting.uncheck()]);
  await page.reload();await setting.waitFor();assert.equal(await setting.isChecked(),false);
  await page.goto(app.url+'/#workspace/jobs');await page.getByRole('heading',{name:'Saved job searches'}).waitFor();await report.waitFor();
  assert.equal(await page.getByRole('button',{name:/Save scout settings|Follow board|Save private listing/}).count(),0);
  assert.deepEqual(errors,[]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser } from './browser.mjs';
import { localHost } from '../../../tests/local-host.mjs';

test('a browser can try the fictional sample, confirm evidence, resume a round, and retry without changing the grade', async t => {
  const app = await localHost(t);
  const browser = await launchBrowser(t);
  const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const apiCalls = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.url) return route.abort();
    if (url.pathname.startsWith('/api/')) apiCalls.push(url.pathname);
    return route.continue();
  });
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Try a fictional sample' }).click();
  await page.getByRole('button', { name: 'How they checked the result' }).click();
  await page.getByText('Use the observation.').waitFor();
  await page.getByRole('button', { name: 'Reset sample' }).click();
  assert.deepEqual(apiCalls, []);
  await page.getByRole('link', { name: 'Back to start' }).click();
  await page.getByRole('button', { name: 'Open my local workspace' }).click();
  const tabs = page.getByRole('navigation', {name:'Workspace sections'});
  await tabs.waitFor();
  assert.deepEqual(await tabs.getByRole('link').allTextContents(),['Job experience','Chat','Schedule']);
  const say = async text => {
    await page.getByLabel('Message your coach').fill(text);
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.getByRole('list',{name:'Chat transcript'}).getByText(text,{exact:true}).waitFor();
  };
  await say('Project: Rollout guide. I wrote the checklist.');
  await tabs.getByRole('link',{name:'Job experience'}).click();
  await page.getByRole('button', { name: 'Confirm fact' }).click();
  await page.getByText('Confirmed / candidate chat statement').waitFor();
  await tabs.getByRole('link',{name:'Chat',exact:true}).click();
  await page.getByRole('link',{name:'New chat',exact:true}).click();
  await page.getByRole('link',{name:/Mock interview.*Practice/}).click();
  await say('Platform engineer');
  for (const [i, text] of ['I wrote the checklist.', 'We compared two rollout paths.', 'I reviewed support tickets.', 'We practiced then expanded.'].entries()) {
    await page.getByText(`Question ${i + 1} of 4`, { exact: false }).waitFor();
    if (i === 1) { await page.reload(); await page.getByText('Question 2 of 4', { exact: false }).waitFor(); }
    await say(text);
  }
  await page.getByText(/Practice scorecard.*Simulated no-hire/).waitFor();
  const scorecard = await page.locator('.artifact p').textContent();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('link',{name:/Review scorecard/}).click();
  await page.getByLabel('Your revised answer').fill('My own contribution was rehearsing the fallback with support.');
  await page.getByRole('button', { name: 'Save ungraded retry' }).click();
  await page.getByRole('heading', { name: 'Saved retry' }).waitFor();
  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await page.getByRole('link', { name: 'History',exact:true }).click();
  await page.getByRole('link', { name: /Mock · Platform engineer/ }).click();
  await page.locator('.artifact p').waitFor();
  assert.equal(await page.locator('.artifact p').textContent(), scorecard);
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

test('a signed-out customer reaches the branded choices, not a local workspace or Firebase', async t => {
  const browser = await launchBrowser(t), page = await browser.newPage();
  const root = process.env.INTERVIEW_PREP_WEBROOT || fileURLToPath(new URL('../../api/wwwroot/', import.meta.url));
  const origin = 'https://practice.example.invalid', outside = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType:'text/html', body:(await readFile(join(root,'index.html'),'utf8'))
      .replace('<head>','<head><meta name="customer-sign-in" content="1">') });
    if (url.pathname === '/assets/app.js' || url.pathname === '/assets/app.css') return route.fulfill({path:join(root,url.pathname.slice(1))});
    if (url.pathname === '/api/workspace') return route.fulfill({status:401, body:''});
    if (url.pathname === '/api/account/config') return route.fulfill({json:{ enabled:true, customer:true, migration:false, webApiKey:null }});
    if (url.pathname === '/auth/sign-in/google') return route.fulfill({body:'Hosted sign-in handoff'});
    return route.fulfill({status:404, body:''});
  });
  await page.goto(origin);
  await page.getByRole('button',{name:'Open my workspace'}).click();
  await page.getByRole('heading',{name:'Welcome to Interview Prep'}).waitFor();
  for (const [label, method] of [['Continue with Apple','apple'], ['Continue with Google','google'],
    ['Continue with Microsoft','microsoft'], ['Use a username and password','local']])
    assert.equal(await page.getByRole('link',{name:label}).getAttribute('href'),`/auth/sign-in/${method}`);
  assert.equal(await page.getByRole('button',{name:'Email me a sign-in link'}).count(),0);
  await page.getByRole('link',{name:'Continue with Google'}).click();
  await page.waitForURL(`${origin}/auth/sign-in/google`);
  assert.deepEqual(outside, []);
});

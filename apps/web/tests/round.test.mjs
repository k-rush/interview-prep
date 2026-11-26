import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser } from './browser.mjs';
import { localHost } from '../../../tests/local-host.mjs';

test('a browser can try the fictional sample, confirm evidence, resume a round, and retry without changing the grade', async t => {
  const app = await localHost(t);
  const browser = await launchBrowser(t);
  const page = await browser.newPage();
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
  await page.getByLabel('Project name').fill('Rollout guide');
  await page.getByLabel('Your statement').fill('I wrote a rollout checklist.');
  await page.getByRole('button', { name: 'Review proposed fact' }).click();
  await page.getByRole('button', { name: 'Confirm fact' }).click();
  await page.getByText('Confirmed / candidate statement').waitFor();
  await page.getByLabel('Role or short job description').fill('Platform engineer');
  await page.getByRole('button', { name: 'Start text mock' }).click();
  for (const [i, text] of ['I wrote the checklist.', 'We compared two rollout paths.', 'I reviewed support tickets.', 'We practiced then expanded.'].entries()) {
    await page.getByText(`Question ${i + 1} of 4`, { exact: false }).waitFor();
    if (i === 1) { await page.reload(); await page.getByText('Question 2 of 4', { exact: false }).waitFor(); }
    await page.getByLabel('Your answer', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save answer' }).click();
  }
  for (const [name, points] of [['Ownership', 3], ['Judgment', 3], ['Impact', 3], ['Clarity', 4]])
    await page.getByLabel(`${name} rating`).selectOption(String(points));
  await page.getByRole('button', { name: 'Save self-assessment' }).click();
  await page.getByRole('heading', { name: /81.25\/100 \(B\).*Simulated hire/ }).waitFor();
  await page.getByText('Self-assessed / not an AI evaluation').waitFor();
  await page.getByLabel('Your revised answer').fill('My own contribution was rehearsing the fallback with support.');
  await page.getByRole('button', { name: 'Save ungraded retry' }).click();
  await page.getByRole('heading', { name: 'Saved retry' }).waitFor();
  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await page.getByRole('link', { name: 'View debrief' }).click();
  await page.getByRole('heading', { name: /81.25\/100 \(B\)/ }).waitFor();
  assert.deepEqual(errors, []);
});

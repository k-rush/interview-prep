import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

export async function launchBrowser(t) {
  const exe = [process.env.INTERVIEW_PREP_BROWSER,
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
  assert.ok(exe, 'Set INTERVIEW_PREP_BROWSER to an installed Chrome, Chromium or Edge executable.');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  return browser;
}

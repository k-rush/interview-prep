import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../apps/api/', import.meta.url));
export async function localHost(t, modelPort, overrides = {}) {
  const data = await mkdtemp(join(tmpdir(), 'interview-prep-fixture-'));
  let child, base;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    child.kill();
    await done;
  }
  async function start() {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTERVIEW_PREP_'))),
      ...overrides, INTERVIEW_PREP_DATA: data, INTERVIEW_PREP_PORT: '0', ASPNETCORE_ENVIRONMENT: 'Production' };
    if (process.env.INTERVIEW_PREP_WEBROOT) env.INTERVIEW_PREP_WEBROOT = process.env.INTERVIEW_PREP_WEBROOT;
    if (modelPort) env.INTERVIEW_PREP_MODEL_PORT = String(modelPort);
    child = spawn('dotnet', [join(project, 'bin', process.env.INTERVIEW_PREP_BUILD || 'Release', 'net10.0', 'InterviewPrep.Api.dll')],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`App startup timed out: ${output}`)), 30_000);
      const failed = error => { clearTimeout(timer); reject(error); };
      child.once('error', failed);
      child.once('exit', code => failed(new Error(`App exited (${code}): ${output}`)));
      child.stderr.on('data', chunk => { output += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /Now listening on: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) { base = match[1]; clearTimeout(timer); resolve(); }
      });
    });
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  }
  t.after(async () => {
    await stop();
    for (const suffix of ['', '-shm', '-wal', '-journal']) await rm(join(data, `practice.sqlite${suffix}`), { force: true });
    await rmdir(data);
  });
  await start();
  const request = (path, cookie, method = 'GET', body, extra = {}) => fetch(`${base}/api/${path}`, {
    method, headers: { 'X-Practice-Request': '1', ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, body: JSON.stringify(body)
  });
  async function open() {
    const response = await request('workspace', null, 'POST');
    assert.equal(response.status, 204);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { get url() { return base; }, request, open,
    state: async cookie => (await request('workspace', cookie)).json(),
    restart: async () => { await stop(); await start(); } };
}

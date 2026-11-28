import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, EvalError, failure } from './gateway.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validId = id => typeof id === 'string' && id.length <= 100 && slug.test(id);

export function catalog(families) {
  const scenarios = new Set(), cases = [];
  check(Array.isArray(families) && families.length, 'empty-corpus');
  for (const family of families) {
    check(Array.isArray(family) && family.length, 'empty-or-invalid-family');
    for (const s of family) {
      check(validId(s?.id) && typeof s.title === 'string' && s.title.trim(), 'invalid-scenario');
      check(!scenarios.has(s.id), 'duplicate-scenario'); scenarios.add(s.id);
      check(Array.isArray(s.conversations) && s.conversations.length >= 2, 'scenario-needs-two-conversations');
      const conversations = new Set();
      for (const c of s.conversations) {
        check(validId(c?.id) && typeof c.run === 'function', 'invalid-conversation');
        check(!conversations.has(c.id), 'duplicate-conversation'); conversations.add(c.id);
        const lanes = c.lanes === undefined ? ['replay', 'live'] : c.lanes;
        check(Array.isArray(lanes) && lanes.includes('replay') && lanes.every(l => l === 'replay' || l === 'live') &&
          new Set(lanes).size === lanes.length, 'invalid-conversation-lanes');
        check(c.workflowOnly === undefined || typeof c.workflowOnly === 'boolean', 'invalid-workflow-only');
        cases.push({ id: `${s.id}/${c.id}`, scenario: s.id, lanes, workflowOnly: c.workflowOnly === true, run: c.run });
      }
    }
  }
  return cases;
}

export function select(cases, selectors = []) {
  check(cases.length > 0, 'empty-corpus');
  if (!selectors.length) return cases;
  const ids = new Set();
  for (const value of selectors) {
    const matches = cases.filter(c => c.scenario === value || c.id === value);
    check(matches.length, 'unknown-case-selector');
    for (const c of matches) { check(!ids.has(c.id), 'overlapping-case-selectors'); ids.add(c.id); }
  }
  return cases.filter(c => ids.has(c.id));
}

async function corpusFiles(dir, prefix) {
  const files = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const name = `${prefix}/${entry.name}`, path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await corpusFiles(path, name));
    else { check(entry.isFile(), 'invalid-corpus-file'); files.push({ name, path }); }
  }
  return files;
}

function git(...args) {
  try { return execFileSync('git', ['--no-pager', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export async function loadCorpus() {
  const dir = join(root, 'evals'), casesDir = join(dir, 'cases');
  const files = [...await corpusFiles(casesDir, 'cases'), ...await corpusFiles(join(dir, 'fixtures'), 'fixtures')];
  const modules = files.filter(f => /^cases\/[^/]+\.mjs$/.test(f.name));
  const hash = createHash('sha256');
  for (const { name, path } of files) {
    const bytes = await readFile(path);
    const content = /\.(mjs|json|txt)$/.test(name) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes;
    hash.update(`${name}\0${content.length}\0`).update(content);
  }
  const families = [];
  for (const file of modules) families.push((await import(pathToFileURL(file.path))).default);
  const revision = git('log', '-1', '--format=%H', '--', 'evals/cases', 'evals/fixtures');
  const source = git('rev-parse', 'HEAD');
  return { cases: catalog(families), corpus: { revision: revision || 'uncommitted', fingerprint: hash.digest('hex') },
    source: { commit: source || null, dirty: source ? !!git('status', '--porcelain') : null } };
}

// localHost reads process.env for its child, build path and temporary SQLite directory. The dedicated
// CLI process replaces its environment with this allowlist before starting it; no application,
// cloud, Kestrel, credential, hosted profile, proxy or model configuration is inherited.
export function hostEnvironment(inherited, dataRoot, proxyPort) {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES(?:\(X86\))?|DOTNET_ROOT(?:_X64|_ARM64|\(X86\))?|LANG|LC_ALL)$/i;
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => keep.test(key)));
  const proxy = `http://127.0.0.1:${proxyPort}`;
  return { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost,::1',
    TEMP: dataRoot, TMP: dataRoot, TMPDIR: dataRoot, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1',
    INTERVIEW_PREP_BUILD: inherited.INTERVIEW_PREP_BUILD === 'Debug' ? 'Debug' : 'Release' };
}

function appOrigin(host) {
  const origin = new URL(host.url);
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port && origin.href === `${origin.origin}/`, 'non-loopback-api');
  return origin.origin;
}

export async function verifyHost(host, pack) {
  const res = await fetch(`${appOrigin(host)}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const health = res.ok && await res.json();
  check(health?.mode === 'local-practice' && health.promptPack?.version === pack.version && health.promptPack.digest === pack.digest,
    'host-mode-or-pack-mismatch');
}

export function caseRows(selected, lane) {
  return selected.map(c => ({ id: c.id, status: c.lanes.includes(lane) ? 'not-run' : 'skipped', exercise: null,
    ...(c.lanes.includes(lane) ? {} : { reason: 'replay-only' }), calls: [], failures: [], durationMs: 0 }));
}

function apiUrl(base, path) {
  check(typeof path === 'string' && path && !/^(?:\/\/|[a-z][a-z0-9+.-]*:)|[\\\x00-\x1f#]/i.test(path), 'invalid-api-path');
  const url = new URL(path.replace(/^\/(?:api\/)?/, ''), `${base}/api/`);
  check(url.origin === base && url.pathname.startsWith('/api/'), 'invalid-api-path');
  return url;
}

function journey(host, scope, lane) {
  const base = appOrigin(host);
  let closed = false, pending, requests = 0;
  function idle() {
    if (!closed && !pending) return;
    const code = closed ? 'expired-case-context' : 'overlapping-case-operations';
    scope.record(code); throw new EvalError(code);
  }
  const guard = operation => (...args) => {
    idle();
    const p = pending = Promise.resolve().then(() => operation(...args));
    p.then(() => { pending = null; }, () => { pending = null; });
    return p;
  };
  const open = async () => {
    const cookie = await host.open();
    async function request(path, method = 'GET', body) {
      const url = apiUrl(base, path), firstCall = scope.calls.length;
      requests++;
      const res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(300_000),
        headers: { cookie, 'X-Practice-Request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: JSON.stringify(body) });
      if (lane === 'live' && scope.calls.length > firstCall && !res.ok)
        scope.failures.push({ code: `application-rejected-completion-${res.status}` });
      return res;
    }
    async function api(path, method, body) {
      const res = await request(path, method, body);
      check(res.ok, `api-http-${res.status}`);
      return res.status === 204 ? null : res.json();
    }
    const chat = id => `chats/${encodeURIComponent(id)}`;
    return Object.freeze({ lane, request: guard(request), api: guard(api), state: guard(() => api('workspace')),
      peer: guard(open),
      expect(...args) { idle(); scope.expect(...args); },
      start: guard(async (kind = 'chat') => {
        const { id } = await api('chats', 'POST', { kind, requestId: randomUUID() });
        check(typeof id === 'string' && id, 'invalid-chat-id'); return id;
      }),
      say: guard(async (id, text, { zone = 'UTC', action } = {}) => {
        const before = await api(chat(id)), firstCall = scope.calls.length;
        const revision = before.session?.revision;
        check(Number.isInteger(revision), 'invalid-chat-revision');
        const result = await api(`${chat(id)}/turns`, 'POST', { revision, text, zone, action, requestId: randomUUID() });
        const detail = await api(chat(result.id)), reply = detail.messages?.at(-1);
        check(reply?.speaker === 'assistant', 'missing-assistant-message');
        if (lane === 'live' && scope.calls.length > firstCall &&
          (/model unavailable|offline guide|standard probe/i.test(reply.mode) ||
           (reply.mode === 'scorecard' && /offline wording checklist/i.test(reply.text)))) {
          scope.failures.push({ code: 'application-fallback' });
        }
        return detail;
      })
    });
  };
  return { open, async finish() {
    closed = true;
    if (pending) { scope.failures.push({ code: 'unfinished-case-operation' }); await Promise.allSettled([pending]); }
    if (!requests) scope.failures.push({ code: 'empty-api-journey' });
  } };
}

export async function runCases({ selected, rows, lane, host, gateway, verify = async () => {} }) {
  check(selected.length === rows.length && rows.some(r => r.status !== 'skipped'), 'no-eligible-conversations');
  for (const [index, conversation] of selected.entries()) {
    const row = rows[index];
    if (row.status === 'skipped') continue;
    await verify();
    const start = performance.now(), scope = gateway.begin(), context = journey(host, scope, lane);
    try { await conversation.run(await context.open()); }
    catch (err) { scope.failures.push(failure(err, err?.code === 'ERR_ASSERTION' ? 'case-assertion' : 'case-error')); }
    finally { await context.finish(); await scope.end(); }
    row.calls = scope.calls; row.failures = scope.failures;
    row.exercise = !conversation.workflowOnly && (row.calls.length || row.failures.some(f => f.code === 'missing-model-call'))
      ? 'model-exercising' : 'rules-only';
    row.status = row.failures.length ? 'failed' : 'passed';
    row.durationMs = Math.round(performance.now() - start);
  }
  await verify();
}

export function summarize(report) {
  const count = (status, exercise) => report.cases.filter(c => c.status === status && (!exercise || c.exercise === exercise)).length;
  const slice = exercise => ({ passed: count('passed', exercise), failed: count('failed', exercise) });
  return { selected: report.cases.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'),
    notRun: count('not-run'), modelExercising: slice('model-exercising'), rulesOnly: slice('rules-only'),
    liveModelPasses: report.lane === 'live' ? count('passed', 'model-exercising') : 0 };
}

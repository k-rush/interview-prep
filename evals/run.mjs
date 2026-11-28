import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localHost } from '../tests/local-host.mjs';
import { check, createGateway, EvalError, failure, modelAdapter, sha256 } from './gateway.mjs';
import { caseRows, hostEnvironment, loadCorpus, root, runCases, select, summarize, verifyHost } from './harness.mjs';

const usage = 'node evals/run.mjs --lane replay|live [--case scenario-id[/conversation-id]] [--report path] [--store path]\n' +
  'node evals/run.mjs --list [--case scenario-id[/conversation-id]]';

export function options(argv) {
  const result = { selectors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    check(['--lane', '--case', '--report', '--store', '--list'].includes(arg), 'unknown-option');
    const name = arg.slice(2);
    check(arg === '--case' || !Object.hasOwn(result, name), 'duplicate-option');
    if (arg === '--list') { result.list = true; continue; }
    const value = argv[++i];
    check(value?.trim() && !value.startsWith('--'), 'missing-option-value');
    if (arg === '--case') result.selectors.push(value);
    else result[name] = arg === '--lane' ? value : resolve(value);
  }
  check((result.list && !result.lane) || ['replay', 'live'].includes(result.lane), 'choose-replay-or-live');
  check(!result.list || (!result.store && !result.report), 'invalid-list-options');
  return result;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(usage); return; }
  const opts = options(argv);
  const start = performance.now(), cleanup = [];
  const report = { schema: 'interview-prep-eval/1', startedAt: new Date().toISOString(), lane: opts.lane, apiBinarySha256: null,
    model: null, pack: null, corpus: null, source: null, settings: { temperature: 0, stream: false, transport: 'chat-completions-v1' },
    cases: [], failures: [] };
  let gateway;
  try {
    const { cases, corpus, source } = await loadCorpus();
    const selected = select(cases, opts.selectors);
    if (opts.list) {
      console.log(JSON.stringify(selected.map(({ id, lanes, workflowOnly }) => ({ id, lanes, workflowOnly })), null, 2));
      return;
    }
    Object.assign(report, { corpus, source, cases: caseRows(selected, opts.lane) });
    const files = ['evals/run.mjs', 'evals/harness.mjs', 'evals/gateway.mjs', 'tests/local-host.mjs'];
    const sources = await Promise.all(files.map(f => readFile(join(root, f), 'utf8')));
    report.evaluatorFingerprint = sha256(sources.map(s => s.replaceAll('\r\n', '\n')).join('\0'));
    let pack;
    try { const { loadPack } = await import('../scripts/prompt-pack.mjs'); pack = await loadPack(opts.store); }
    catch { throw new EvalError('cannot-load-prompt-pack'); }
    check(/^\d+\.\d+\.\d+$/.test(pack?.version) && /^[a-f0-9]{64}$/.test(pack.digest), 'invalid-pack-identity');
    report.pack = { version: pack.version, digest: pack.digest };
    check(report.cases.some(c => c.status !== 'skipped'), 'no-eligible-conversations');
    const adapter = await modelAdapter(opts.lane);
    report.model = adapter.model;
    gateway = await createGateway(pack.prompts, adapter);
    cleanup.push(() => gateway.close());

    const obj = join(root, 'apps', 'api', 'obj');
    await mkdir(obj, { recursive: true });
    const scratch = await mkdtemp(join(obj, 'prompt-eval-'));
    cleanup.push(() => rm(scratch, { recursive: true, force: true, maxRetries: 3 }));
    const keyFile = join(scratch, 'gateway.key');
    await writeFile(keyFile, gateway.token, { flag: 'wx', mode: 0o600 });
    const env = hostEnvironment(process.env, scratch, gateway.port);
    // This entry point owns its process; localHost must not see the operator's WEBROOT, model key,
    // arbitrary environment configuration providers, or machine temp directory.
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
    Object.assign(process.env, env);
    const dll = join(root, 'apps', 'api', 'bin', env.INTERVIEW_PREP_BUILD, 'net10.0', 'InterviewPrep.Api.dll');
    const hashBinary = async () => sha256(await readFile(dll));
    try { report.apiBinarySha256 = await hashBinary(); } catch { throw new EvalError('build-api-before-running-evals'); }
    const fixtures = join(root, 'evals', 'fixtures'), recording = join(fixtures, 'scout-search.json');
    await access(recording);
    let host;
    try {
      host = await localHost({ after: fn => cleanup.push(fn) }, gateway.port, {
        INTERVIEW_PREP_MODEL_ID: adapter.model.id, INTERVIEW_PREP_MODEL_KEY_FILE: keyFile,
        INTERVIEW_PREP_SCOUT_REPLAY_DIR: fixtures, INTERVIEW_PREP_SCOUT_SEARCH_REPLAY_FILE: recording,
        INTERVIEW_PREP_SCOUT_BOARDS: '', INTERVIEW_PREP_HN_JOB_SEARCH: '0',
        ...(opts.store ? { INTERVIEW_PREP_PROMPT_STORE: opts.store } : {})
      });
    } catch (error) {
      throw new EvalError(/\b0x800711C7\b/i.test(error?.message) ? 'local-api-blocked-by-application-control' : 'local-api-start-failed');
    }
    check(await hashBinary() === report.apiBinarySha256, 'api-binary-changed-during-startup');
    await runCases({ selected, rows: report.cases, lane: opts.lane, host, gateway, verify: () => verifyHost(host, pack) });
    check(await hashBinary() === report.apiBinarySha256, 'api-binary-changed-during-run');
  } catch (error) {
    report.failures.push(failure(error, 'evaluation-setup-failed'));
  } finally {
    for (const dispose of cleanup.reverse()) {
      try { await dispose(); } catch { report.failures.push({ code: 'cleanup-failed' }); }
    }
    if (gateway) report.failures.push(...gateway.failures);
  }
  report.durationMs = Math.round(performance.now() - start);
  report.summary = summarize(report);
  report.ok = !report.failures.length && !report.summary.failed && !report.summary.notRun && report.summary.passed > 0;
  if (opts.report) await writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, lane: report.lane, model: report.model, pack: report.pack, ...report.summary,
    skippedReplayOnly: report.cases.filter(c => c.status === 'skipped').map(c => c.id),
    failures: report.failures, failedCases: report.cases.filter(c => c.status === 'failed').map(({ id, failures }) => ({ id, failures })) }));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(err => { console.error(failure(err, 'evaluation-command-failed').code, '\n' + usage); process.exitCode = 1; });
}

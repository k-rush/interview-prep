import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { check, failure } from './gateway.mjs';
import { slug } from './harness.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const prompt = value => typeof value === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);

function index(report) {
  check(report?.schema === 'interview-prep-eval/1' && ['replay', 'live'].includes(report.lane) &&
    typeof report.model?.id === 'string' && report.model.id && typeof report.model.provider === 'string' &&
    digest(report.apiBinarySha256) && digest(report.evaluatorFingerprint) && digest(report.corpus?.fingerprint) && report.corpus.revision &&
    digest(report.pack?.digest) && /^\d+\.\d+\.\d+$/.test(report.pack.version) && report.settings?.transport &&
    Array.isArray(report.failures) && !report.failures.length, 'incomplete-or-invalid-report');
  check(report.lane === 'live' ? report.model.provider === 'loopback-openai-compatible' &&
    Number.isInteger(report.model.port) && report.model.port >= 1 && report.model.port <= 65535 :
    report.model.provider === 'replay-fixture', 'invalid-report-model');
  check(Array.isArray(report.cases) && report.cases.length, 'empty-report');
  const rows = new Map();
  for (const row of report.cases) {
    const parts = typeof row?.id === 'string' && row.id.split('/');
    check(parts?.length === 2 && parts.every(p => p.length <= 100 && slug.test(p)), 'invalid-reported-case');
    check(!rows.has(row.id), 'duplicate-reported-case');
    check(Array.isArray(row.calls) && Array.isArray(row.failures), 'invalid-case-result');
    if (row.status === 'skipped') {
      check(report.lane === 'live' && row.reason === 'replay-only' && !row.calls.length && !row.failures.length &&
        row.exercise === null, 'invalid-case-skip');
    } else {
      check(['passed', 'failed'].includes(row.status) && ['model-exercising', 'rules-only'].includes(row.exercise) &&
        (row.status === 'failed') === (row.failures.length > 0), 'incomplete-case-result');
      if (row.status === 'passed') {
        check(row.exercise === 'rules-only' || row.calls.length > 0, 'missing-model-evidence');
        for (const c of row.calls) check(prompt(c.prompt) && c.prompt === c.expected && digest(c.settings) &&
          (report.lane === 'live' ? c.outcome === 'live-completion' : ['replayed', 'fixture-unavailable'].includes(c.outcome)),
        'invalid-model-evidence');
      }
    }
    rows.set(row.id, row);
  }
  check([...rows.values()].some(r => r.status !== 'skipped'), 'no-eligible-conversations');
  return rows;
}

export function compare(baseline, candidate) {
  const before = index(baseline), after = index(candidate);
  for (const key of ['lane', 'model', 'corpus', 'settings', 'apiBinarySha256', 'evaluatorFingerprint'])
    check(isDeepStrictEqual(baseline[key], candidate[key]), `different-${key}`);
  check(before.size === after.size && [...before.keys()].every(id => after.has(id)), 'different-case-selection');
  const regressions = [], improvements = [], stillFailing = [];
  for (const [id, b] of before) {
    const c = after.get(id);
    for (const [i, call] of b.calls.entries()) {
      const current = c.calls[i];
      if (call.settings && current?.settings && call.prompt === current.prompt)
        check(call.settings === current.settings, 'different-generation-settings');
    }
    if (b.status !== 'skipped' && c.status === 'skipped') regressions.push({ id, reason: 'lost-coverage' });
    else if (b.status !== 'failed' && c.status === 'failed') regressions.push({ id, reason: 'new-failure' });
    else if (b.status === 'passed' && c.status === 'passed' && b.exercise === 'model-exercising' && c.exercise !== b.exercise)
      regressions.push({ id, reason: 'lost-model-coverage' });
    else if (b.status === 'passed' && c.status === 'passed' && !isDeepStrictEqual(b.calls.map(x => x.prompt), c.calls.map(x => x.prompt)))
      regressions.push({ id, reason: 'changed-model-call-plan' });
    else if (b.status === 'failed' && c.status === 'passed') improvements.push(id);
    else if (b.status === 'failed' && c.status === 'failed') stillFailing.push(id);
  }
  return { compatible: true, lane: baseline.lane, baseline: baseline.pack.digest, candidate: candidate.pack.digest,
    selected: before.size, regressions, improvements, stillFailing };
}

async function main(args) {
  if (args.length === 4 && args[0] === '--baseline' && args[2] === '--candidate') args = [args[1], args[3]];
  check(args.length === 2 && args.every(a => a && !a.startsWith('--')), 'usage: node evals/compare.mjs BASELINE.json CANDIDATE.json');
  const [a, b] = await Promise.all(args.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const result = compare(a, b);
  console.log(JSON.stringify(result, null, 2));
  if (result.regressions.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(err => {
    console.error(JSON.stringify({ compatible: false, error: failure(err, 'cannot-read-report').code })); process.exitCode = 1;
  });
}
